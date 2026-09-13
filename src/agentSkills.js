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
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

// Parse the spec's shallow frontmatter fields without adding a YAML runtime.
// metadata is retained as string pairs; malformed/unsupported YAML is diagnosed.
function parseSkillFile(text, directoryName) {
  const diagnostics = [];
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { valid: false, diagnostics: ['missing YAML frontmatter'] };
  const lines = text.split(/\r?\n/);
  const close = lines.indexOf('---', 1);
  if (close < 0) return { valid: false, diagnostics: ['unterminated YAML frontmatter'] };
  const metadata = {};
  let map = null;
  for (const line of lines.slice(1, close)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const nested = line.match(/^\s+([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (nested && map) { map[nested[1]] = parseScalar(nested[2]); continue; }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) { diagnostics.push('unsupported YAML line: ' + line.trim()); continue; }
    if (m[1] === 'metadata' && !m[2]) { metadata.metadata = {}; map = metadata.metadata; continue; }
    map = null;
    metadata[m[1]] = parseScalar(m[2]);
  }
  const name = metadata.name || '';
  const description = metadata.description || '';
  if (!name) diagnostics.push('name is required');
  if (!description) diagnostics.push('description is required');
  if (name && (!NAME_RE.test(name) || name.length > 64 || name !== directoryName)) diagnostics.push('name must match its directory and use 1-64 lowercase letters, numbers, or single hyphens');
  if (description.length > 1024) diagnostics.push('description exceeds 1024 characters');
  if (metadata.compatibility && metadata.compatibility.length > 500) diagnostics.push('compatibility exceeds 500 characters');
  const validName = !!name && NAME_RE.test(name) && name.length <= 64 && name === directoryName;
  const validDescription = !!description && description.length <= 1024;
  const validCompatibility = !metadata.compatibility || metadata.compatibility.length <= 500;
  return { valid: validName && validDescription && validCompatibility, name, description, metadata, body: lines.slice(close + 1).join('\n').trim(), diagnostics };
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
