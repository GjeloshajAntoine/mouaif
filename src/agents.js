'use strict';

// Project agents — named, project-scoped agent personas under
// `<projectDir>/.agents/agents/<name>/AGENT.md`.
//
// Agents are read-only Markdown instruction files. A selected chat agent is
// injected into the upstream system context, and the native `subagent` tool can
// target one by name for focused delegated work.

const fs = require('fs');
const path = require('path');
const settings = require('./settings.js');

const AGENTS_DIR = path.join('.agents', 'agents');
const AGENT_FILE = 'AGENT.md';
const MAX_BYTES = 64 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function discover(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return [];
  const root = path.join(projectDir, AGENTS_DIR);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!NAME_RE.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const file = path.join(dir, AGENT_FILE);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) out.push({ name: entry.name, dir, file, size: st.size });
    } catch { /* missing or unreadable AGENT.md — skip */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function readAgent(entry) {
  let text;
  try {
    const buf = fs.readFileSync(entry.file);
    text = buf.length > MAX_BYTES
      ? buf.slice(0, MAX_BYTES).toString('utf8') + '\n\n[... truncated at ' + MAX_BYTES + ' bytes ...]'
      : buf.toString('utf8');
  } catch { return null; }
  if (!text.trim()) return null;
  const firstHeading = text.match(/^#\s+(.+)$/m);
  const title = firstHeading ? firstHeading[1].trim() : entry.name;
  return {
    name: entry.name,
    title,
    role: 'system',
    content: 'Project agent "' + title + '" from ' + path.join(AGENTS_DIR, entry.name, AGENT_FILE) + ':\n\n' + text
  };
}

function load(projectDir) {
  return discover(projectDir).map(readAgent).filter(Boolean);
}

function loadOne(projectDir, name) {
  if (!isValidName(name)) return null;
  const entry = discover(projectDir).find(a => a.name === name);
  return entry ? readAgent(entry) : null;
}

function resolveSelected({ chat, projectDir } = {}) {
  if (chat && typeof chat.agentId === 'string' && chat.agentId) return chat.agentId;
  if (projectDir) {
    try {
      const project = settings.getProject(projectDir);
      const value = project && (project.agentId || project.defaultAgentId);
      if (typeof value === 'string' && value) return value;
    } catch { /* fall through */ }
  }
  return null;
}

function loadSelected({ chat, projectDir } = {}) {
  const name = resolveSelected({ chat, projectDir });
  return name ? loadOne(projectDir, name) : null;
}

module.exports = {
  AGENTS_DIR,
  AGENT_FILE,
  MAX_BYTES,
  NAME_RE,
  discover,
  load,
  loadOne,
  loadSelected,
  resolveSelected,
  isValidName
};
