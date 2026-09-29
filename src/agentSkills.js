'use strict';

// Agent Skills-compatible discovery and progressive activation.
// Format: https://agentskills.io/specification

const fs = require('fs');
const path = require('path');
const settings = require('./settings.js');
const MAX_BYTES = 512 * 1024;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseScalar(raw) {
  const s = String(raw || '').trim();
  if (s[0] === '"' || s[0] === "'") {
    const quote = s[0];
    let value = '';
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (ch === quote) {
        if (quote === "'" && s[i + 1] === "'") { value += "'"; i++; continue; }
        if (!/^\s*(?:#.*)?$/.test(s.slice(i + 1))) throw new Error('unexpected text after quoted scalar');
        return value;
      }
      if (quote === '"' && ch === '\\') {
        const escape = s[++i];
        const escapes = { '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029' };
        if (Object.prototype.hasOwnProperty.call(escapes, escape)) value += escapes[escape];
        else if (['x', 'u', 'U'].includes(escape)) {
          const digits = { x: 2, u: 4, U: 8 }[escape];
          const hex = s.slice(i + 1, i + 1 + digits);
          if (hex.length !== digits || !/^[a-f0-9]+$/i.test(hex) || parseInt(hex, 16) > 0x10ffff) throw new Error('invalid quoted escape');
          value += String.fromCodePoint(parseInt(hex, 16));
          i += digits;
        } else throw new Error('unsupported quoted escape');
      } else value += ch;
    }
    throw new Error('unterminated quoted scalar');
  }
  const value = s.replace(/(?:^|\s+)#.*$/, '').trim();
  // This reader supports the spec's string fields, not arbitrary YAML
  // collections, aliases, tags, or multiline plain/quoted scalars.
  if (/^[\[\]{}&*!|>@`]/.test(value) || /:\s|:$/.test(value)) throw new Error('unsupported YAML scalar');
  return value;
}

function parseBlockScalar(lines, start, header, parentIndent) {
  const marker = header.replace(/\s+#.*$/, '').trim();
  if (!/^[|>](?:[+-][1-9]?|[1-9][+-]?)?$/.test(marker)) throw new Error('unsupported block scalar header');
  const explicit = marker.match(/[1-9]/);
  let indent = explicit ? parentIndent + Number(explicit[0]) : null;
  const values = [];
  let next = start;
  for (; next < lines.length; next++) {
    const line = lines[next];
    if (!line.trim()) { values.push(''); continue; }
    const spaces = /^ */.exec(line)[0].length;
    if (spaces <= parentIndent) break;
    if (indent === null) indent = spaces;
    if (spaces < indent || line[spaces] === '\t') throw new Error('invalid block scalar indentation');
    values.push(line.slice(indent));
  }
  let value = '';
  for (let i = 0; i < values.length; i++) {
    const current = values[i];
    const following = values[i + 1];
    value += current;
    // Fold normal adjacent lines; preserve paragraphs and more-indented text.
    if (marker[0] === '>' && following !== undefined && current && following
      && !/^\s/.test(current) && !/^\s/.test(following)) value += ' ';
    else if (marker[0] === '>' && current && following === '' && !/^\s/.test(current)) { /* paragraph break follows */ }
    else value += '\n';
  }
  if (marker.includes('-')) value = value.replace(/\n+$/, '');
  else if (!marker.includes('+')) value = value.replace(/\n+$/, '') + (values.some((line) => line.length) ? '\n' : '');
  return { value, next };
}

// Read the spec's shallow string fields without a YAML dependency. Support
// quoted/plain scalars, comments, block scalars, and a string metadata map.
// Reject unsupported or malformed YAML rather than advertising corrupted text.
function parseSkillFile(text, directoryName) {
  const diagnostics = [];
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { valid: false, diagnostics: ['missing YAML frontmatter'] };
  const lines = text.split(/\r?\n/);
  const close = lines.indexOf('---', 1);
  if (close < 0) return { valid: false, diagnostics: ['unterminated YAML frontmatter'] };
  const metadata = Object.create(null);
  let map = null;
  let mapIndent = null;
  const headerLines = lines.slice(1, close);
  for (let i = 0; i < headerLines.length; i++) {
    const line = headerLines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(/^( *)([A-Za-z0-9_.-]+):(?:\s+(.*)|$)/);
    if (!m) { diagnostics.push('unsupported YAML line: ' + line.trim()); continue; }
    const indent = m[1].length;
    const key = m[2];
    const raw = m[3] || '';
    let target = metadata;
    if (indent) {
      if (!map || (mapIndent !== null && indent !== mapIndent)) {
        diagnostics.push('unsupported YAML indentation: ' + line.trim()); continue;
      }
      mapIndent = indent;
      target = map;
    } else {
      map = null;
      mapIndent = null;
    }
    if (Object.prototype.hasOwnProperty.call(target, key)) { diagnostics.push('duplicate YAML key: ' + key); continue; }
    if (!indent && key === 'metadata' && !raw.replace(/(?:^|\s+)#.*$/, '').trim()) {
      metadata.metadata = Object.create(null);
      map = metadata.metadata;
      continue;
    }
    try {
      if (/^[|>]/.test(raw.trim())) {
        const block = parseBlockScalar(headerLines, i + 1, raw.trim(), indent);
        target[key] = block.value;
        i = block.next - 1;
      } else target[key] = parseScalar(raw);
    } catch (e) { diagnostics.push(key + ': ' + e.message); }
  }
  const name = metadata.name || '';
  const description = metadata.description || '';
  if (!name) diagnostics.push('name is required');
  if (!description.trim()) diagnostics.push('description is required');
  if (name && (!NAME_RE.test(name) || name.length > 64 || name !== directoryName)) diagnostics.push('name must match its directory and use 1-64 lowercase letters, numbers, or single hyphens');
  if (description.length > 1024) diagnostics.push('description exceeds 1024 characters');
  if (metadata.compatibility && metadata.compatibility.length > 500) diagnostics.push('compatibility exceeds 500 characters');
  const validName = !!name && NAME_RE.test(name) && name.length <= 64 && name === directoryName;
  const validDescription = !!description.trim() && description.length <= 1024;
  const validCompatibility = !metadata.compatibility || metadata.compatibility.length <= 500;
  return { valid: diagnostics.length === 0 && validName && validDescription && validCompatibility, name, description, metadata, body: lines.slice(close + 1).join('\n').trim(), diagnostics };
}

function safeSkillFile(projectDir, root, entry) {
  const file = path.join(root, entry.name, 'SKILL.md');
  try {
    const realRoot = fs.realpathSync(projectDir);
    const realFile = fs.realpathSync(file);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return null;
    const stat = fs.statSync(realFile);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const text = fs.readFileSync(realFile, 'utf8');
    const parsed = parseSkillFile(text, entry.name);
    if (!parsed.valid) return null;
    return Object.assign({ id: parsed.name, path: path.relative(projectDir, realFile).replace(/\\/g, '/'), absPath: realFile, root: path.dirname(realFile), size: stat.size }, parsed);
  } catch { return null; }
}

function discover(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return [];
  const root = path.join(projectDir, '.agents', 'skills');
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => safeSkillFile(projectDir, root, e)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

// normalizeDisabledSkills(raw) -> Set<string>
//
// Both the project and the chat carry a `disabledSkills` list of skill
// ids/names. Anything that is not a string list is treated as empty so a
// hand-edited `.mouaif.json` (or a legacy row) can never take discovery down.
function normalizeDisabledSkills(raw) {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.map((n) => String(n)).filter(Boolean));
}

// resolve({ chat, projectDir }) -> {
//   enabled, projectEnabled, disabled, projectDisabled, chatDisabled, skills
// }
//
// `disabled` is the union used for filtering (catalog + activate_skill).
// The two halves are kept separate so the chat UI can tell a skill the
// project switched off (locked, with a reason) from one the user
// unchecked in this chat (a plain per-chat opt-out).
function resolve({ chat, projectDir }) {
let project = {};
try { project = settings.getProject(projectDir) || {}; } catch { /* defaults */ }
const projectEnabled = project.skills !== false;
const enabled = projectEnabled && !(chat && chat.skills === false);
const projectDisabled = normalizeDisabledSkills(project.disabledSkills);
const chatDisabled = normalizeDisabledSkills(chat && chat.disabledSkills);
const disabled = new Set([...projectDisabled, ...chatDisabled]);
return { enabled, projectEnabled, disabled, projectDisabled, chatDisabled, skills: discover(projectDir) };
}

function available(projectDir, chat) {
  const state = resolve({ chat, projectDir });
  return state.enabled ? state.skills.filter((s) => !state.disabled.has(s.name)) : [];
}

function catalogMessage(projectDir, chat) {
  const skills = available(projectDir, chat);
  if (!skills.length) return '';
  return 'Available Agent Skills (metadata only):\n' + skills.map((s) => '- ' + s.name + ': ' + s.description).join('\n')
    + '\nWhen a task matches a skill, call activate_skill with its name before proceeding. Load referenced resources only as needed, relative to the returned skill directory.';
}

function buildSpec(projectDir, chat) {
  const names = available(projectDir, chat).map((s) => s.name);
  if (!names.length) return null;
  return { type: 'function', function: { name: 'activate_skill', description: 'Load one available Agent Skill when its description matches the task.', parameters: { type: 'object', properties: { name: { type: 'string', enum: names, description: 'Skill name from the available skills catalog.' } }, required: ['name'], additionalProperties: false } } };
}

function listResources(skill) {
  const out = [];
  function walk(dir, depth) {
    if (depth > 3 || out.length >= 200) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= 200) break;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.isFile() && abs !== skill.absPath) out.push(path.relative(skill.root, abs).replace(/\\/g, '/'));
    }
  }
  walk(skill.root, 0);
  return out;
}

function activate(projectDir, chat, name) {
  const skill = available(projectDir, chat).find((s) => s.name === name);
  if (!skill) { const e = new Error('skill is unavailable: ' + name); e.code = 'ENO_SKILL'; throw e; }
  const resources = listResources(skill);
  const content = '<skill_content name="' + skill.name + '">\n' + skill.body + '\n\nSkill directory: ' + skill.root
    + '\nRelative paths are relative to this directory.' + (resources.length ? '\nResources (load only when needed):\n' + resources.map((r) => '- ' + r).join('\n') : '') + '\n</skill_content>';
  return { ok: true, content, result: { name: skill.name, description: skill.description, directory: skill.root, resources, content } };
}

module.exports = { MAX_BYTES, NAME_RE, parseSkillFile, discover, resolve, available, catalogMessage, buildSpec, activate };
