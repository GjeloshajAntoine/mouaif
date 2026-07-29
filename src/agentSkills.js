'use strict';

// Project skills are reusable instruction files stored at
// .agents/skills/<slug>/SKILL.md. They share the agent-files context gate but
// can be switched off as a family or individually.

const fs = require('fs');
const path = require('path');
const settings = require('./settings.js');
const MAX_BYTES = 64 * 1024;

function discover(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return [];
  const root = path.join(projectDir, '.agents', 'skills');
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => {
    const file = path.join(root, e.name, 'SKILL.md');
    try {
      const stat = fs.statSync(file);
      return stat.isFile() ? { id: e.name, name: e.name, path: path.relative(projectDir, file).replace(/\\/g, '/'), absPath: file, size: stat.size } : null;
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}

function resolve({ chat, projectDir }) {
  let project = {};
  try { project = settings.getProject(projectDir) || {}; } catch { /* defaults */ }
  const projectEnabled = project.skills !== false;
  const enabled = projectEnabled && !(chat && chat.skills === false);
  const disabled = new Set(Array.isArray(project.disabledSkills) ? project.disabledSkills.map(String) : []);
  return { enabled, projectEnabled, disabled, skills: discover(projectDir) };
}

function load(projectDir, opts) {
  const state = resolve({ chat: opts && opts.chat, projectDir });
  if (!state.enabled) return [];
  const out = [];
  for (const skill of state.skills) {
    if (state.disabled.has(skill.id)) continue;
    try {
      const buf = fs.readFileSync(skill.absPath);
      const truncated = buf.length > MAX_BYTES;
      const text = buf.slice(0, MAX_BYTES).toString('utf8') + (truncated ? '\n\n[... truncated at ' + MAX_BYTES + ' bytes ...]' : '');
      if (text.trim()) out.push({ id: skill.id, name: skill.name, role: 'system', content: 'Project skill ' + skill.id + ' from ' + skill.path + ':\n\n' + text });
    } catch { /* unreadable */ }
  }
  return out;
}

module.exports = { MAX_BYTES, discover, resolve, load };
