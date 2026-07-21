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
const prompts = require('./prompts.js');

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
  if (chat && typeof chat.agentId === 'string' && chat.agentId && loadOne(projectDir, chat.agentId)) return chat.agentId;
  if (projectDir) {
    try {
      const project = settings.getProject(projectDir);
      const value = project && (project.agentId || project.defaultAgentId);
      if (typeof value === 'string' && value && loadOne(projectDir, value)) return value;
    } catch { /* fall through */ }
  }
  return null;
}

function loadSelected({ chat, projectDir } = {}) {
  const name = resolveSelected({ chat, projectDir });
  return name ? loadOne(projectDir, name) : null;
}

function normalizeConfig(raw) {
  const out = raw && typeof raw === 'object' ? raw : {};
  return {
    promptId: typeof out.promptId === 'string' && out.promptId ? out.promptId : null,
    tools: out.tools === null ? null : (Array.isArray(out.tools) ? out.tools.map(String).filter(Boolean) : null),
    selectedSkills: out.selectedSkills === null ? null : (Array.isArray(out.selectedSkills) ? out.selectedSkills.map(String).filter(Boolean) : null)
  };
}

function getConfig(projectDir, name) {
  if (!isValidName(name)) return null;
  const agent = loadOne(projectDir, name);
  if (!agent) return null;
  let project;
  try { project = settings.getProject(projectDir); } catch { project = {}; }
  const all = project && project.agentConfigs && typeof project.agentConfigs === 'object' ? project.agentConfigs : {};
  return normalizeConfig(all[name]);
}

function setConfig(projectDir, name, patch) {
  if (!isValidName(name) || !loadOne(projectDir, name)) return null;
  const project = settings.getProject(projectDir);
  const all = project && project.agentConfigs && typeof project.agentConfigs === 'object' ? Object.assign({}, project.agentConfigs) : {};
  const current = normalizeConfig(all[name]);
  const next = Object.assign({}, current);
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'promptId')) {
    next.promptId = typeof patch.promptId === 'string' && patch.promptId ? patch.promptId : null;
    if (next.promptId && !prompts.getPrompt(projectDir, next.promptId)) next.promptId = null;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'tools')) {
    next.tools = patch.tools === null ? null : (Array.isArray(patch.tools) ? patch.tools.map(String).filter(Boolean) : null);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'selectedSkills')) {
    next.selectedSkills = patch.selectedSkills === null ? null : (Array.isArray(patch.selectedSkills) ? patch.selectedSkills.map(String).filter(Boolean) : null);
  }
  all[name] = next;
  settings.setProject(projectDir, { agentConfigs: all });
  return next;
}

function getDefault(projectDir) {
  if (!projectDir) return null;
  let project;
  try { project = settings.getProject(projectDir); } catch { return null; }
  const name = project && (project.agentId || project.defaultAgentId);
  return typeof name === 'string' && loadOne(projectDir, name) ? name : null;
}

function setDefault(projectDir, name) {
  const next = typeof name === 'string' && name ? name : null;
  if (next && (!isValidName(next) || !loadOne(projectDir, next))) return false;
  settings.setProject(projectDir, { agentId: next });
  return true;
}

function resolveConfig({ chat, projectDir } = {}) {
  const name = resolveSelected({ chat, projectDir });
  return name ? getConfig(projectDir, name) : null;
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
  normalizeConfig,
  getConfig,
  setConfig,
  getDefault,
  setDefault,
  resolveConfig,
  isValidName
};
