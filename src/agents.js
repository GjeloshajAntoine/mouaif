'use strict';

// Project agents — named personas stored in <projectDir>/.mouaif.json
// under `agents`. An agent is used exclusively as a delegation target
// for the native `subagent` tool: when the model calls
// subagent({ task, agent: "<name>" }), the nested call's system
// message is the agent's instructions, optionally restricted to the
// agent's tool allowlist.
//
// Each agent = { name, content, tools?, createdAt, updatedAt }
//   name:    user-defined, unique per project, immutable. Matches
//            NAME_RE. This is the value the subagent `agent` argument
//            is matched against.
//   content: the persona instructions. Injected as the nested call's
//            system message. Capped at MAX_BYTES on write.
//   tools:   optional array of tool names the nested call may use.
//            Absent/empty = inherit the parent's full tool surface.
//
// Agents are NOT chat personas — a chat-level persona is what custom
// prompts are for. Nothing in the stream path, chat record, or project
// record references an agent.
//
// Storage migration: the legacy `agentPresets` key (entries carried
// extra fields like title/modelId/promptSize) is read as a fallback
// for one release; only { id->name, content, tools } survive.

const settings = require('./settings.js');

const MAX_BYTES = 64 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function capContent(content) {
  let text = typeof content === 'string' ? content : '';
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    // Trim to the byte cap on a char boundary, then note the cut.
    let buf = Buffer.from(text, 'utf8').subarray(0, MAX_BYTES);
    text = buf.toString('utf8');
    text += '\n\n[... truncated at ' + MAX_BYTES + ' bytes ...]';
  }
  return text;
}

function normalizeAgent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Accept legacy { id, title, content, tools } entries: id becomes
  // the name, everything else is dropped.
  const name = typeof raw.name === 'string' && raw.name ? raw.name
    : (typeof raw.id === 'string' && raw.id ? raw.id : null);
  if (!name || !isValidName(name)) return null;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.map(String).map((s) => s.trim()).filter(Boolean)
    : undefined;
  return {
    name,
    content: capContent(raw.content),
    tools: tools && tools.length ? tools : undefined,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString()
  };
}

function readRawList(project) {
  if (!project || typeof project !== 'object') return [];
  if (Array.isArray(project.agents)) return project.agents;
  // One-release fallback for the legacy key.
  if (Array.isArray(project.agentPresets)) return project.agentPresets;
  return [];
}

function list(projectDir) {
  if (!projectDir) return [];
  const project = settings.getProject(projectDir);
  return readRawList(project).map(normalizeAgent).filter(Boolean);
}

function get(projectDir, name) {
  if (!isValidName(name)) return null;
  return list(projectDir).find((a) => a.name === name) || null;
}

function writeList(projectDir, agents) {
  settings.setProject(projectDir, { agents });
  // Drop the legacy key once we write the new one.
  try { settings.unsetProjectKeys(projectDir, ['agentPresets']); } catch { /* non-fatal */ }
}

function create(projectDir, opts) {
  const name = opts && typeof opts.name === 'string' ? opts.name.trim() : '';
  if (!isValidName(name)) {
    const error = new Error('Agent name is required and must match ' + NAME_RE);
    error.code = 'EBADINPUT';
    throw error;
  }
  const content = opts && typeof opts.content === 'string' ? opts.content : '';
  const agents = list(projectDir);
  if (agents.some((a) => a.name === name)) {
    const error = new Error('Agent "' + name + '" already exists');
    error.code = 'EBADINPUT';
    throw error;
  }
  const now = new Date().toISOString();
  const agent = normalizeAgent({
    name,
    content,
    tools: Array.isArray(opts.tools) ? opts.tools : undefined,
    createdAt: now,
    updatedAt: now
  });
  agents.push(agent);
  writeList(projectDir, agents);
  return agent;
}

function update(projectDir, name, patch) {
  if (!isValidName(name)) return null;
  const agents = list(projectDir);
  const idx = agents.findIndex((a) => a.name === name);
  if (idx < 0) return null;
  const current = agents[idx];
  const merged = {
    name: current.name, // immutable
    content: Object.prototype.hasOwnProperty.call(patch || {}, 'content')
      ? capContent(patch.content)
      : current.content,
    tools: Object.prototype.hasOwnProperty.call(patch || {}, 'tools')
      ? (Array.isArray(patch.tools)
          ? patch.tools.map(String).map((s) => s.trim()).filter(Boolean)
          : undefined)
      : current.tools,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString()
  };
  if (merged.tools && !merged.tools.length) merged.tools = undefined;
  agents[idx] = merged;
  writeList(projectDir, agents);
  return merged;
}

function remove(projectDir, name) {
  if (!isValidName(name)) return false;
  const agents = list(projectDir);
  const idx = agents.findIndex((a) => a.name === name);
  if (idx < 0) return false;
  agents.splice(idx, 1);
  writeList(projectDir, agents);
  return true;
}

module.exports = {
  MAX_BYTES,
  NAME_RE,
  isValidName,
  list,
  get,
  create,
  update,
  remove
};
