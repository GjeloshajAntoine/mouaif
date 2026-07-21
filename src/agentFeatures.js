'use strict';

// Agent features — dynamic system context that tells the model which
// mouaif features are enabled/disabled for the current project and
// chat session. The model receives a terse summary injected into the
// upstream message array. A companion tool (`list_features`) lets the
// model query the full structured feature state at any time, which is
// especially useful in `very-small` prompt mode.
//
// Public surface:
//   buildFeatureSummary({ chat, projectDir, project, authz, mcpServers })
//     -> string (system-message content) | null
//   LIST_FEATURES_SPEC                : tool spec for the list_features tool
//   dispatchListFeatures(...)         : execute the tool call

const path = require('path');

const TOOL_NAME = 'list_features';

const LIST_FEATURES_SPEC = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Describe every mouaif feature available in this project and their current on/off/ask state. Returns a JSON object with one key per feature family; each value contains the enable state, authorization mode, and a short description.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }
};

// buildFeatureSummary({ chat, projectDir, project, authz, mcpServers })
//
// Compose a short system message describing which features are
// available, enabled, and authorized. Returns null when no features
// are relevant (to avoid injecting an empty message).
function buildFeatureSummary(opts) {
  const { chat, projectDir, project, authz, mcpServers } = opts || {};
  const lines = [];
  const feat = [];

  // --- Built-in tools ---
  // shell
  if (authz && authz.tools && authz.tools.shell) {
    const s = authz.tools.shell;
    if (s.mode !== 'off') {
      feat.push('[shell](off|ask|allow) → ' + s.mode + (s.mode === 'allowlist' ? ' (' + (Array.isArray(s.allowlist) ? s.allowlist.length : 0) + ' patterns)' : ''));
    }
  }
  // subagent
  if (authz && authz.tools && authz.tools.subagent) {
    const s = authz.tools.subagent;
    if (s.mode !== 'off') {
      feat.push('[subagent](off|ask|allow) → ' + s.mode);
    }
  }
  // ask_user
  if (authz && authz.tools && authz.tools.ask_user) {
    const s = authz.tools.ask_user;
    if (s.mode !== 'off') {
      feat.push('[ask_user](off|ask) → ' + s.mode);
    }
  }
  // file tools
  if (authz && authz.tools && authz.tools.file) {
    const s = authz.tools.file;
    if (s.mode !== 'off') {
      feat.push('[file tools](off|ask|allow) → ' + s.mode + (s.mode === 'allowlist' ? ' (' + (Array.isArray(s.allowlist) ? s.allowlist.length : 0) + ' patterns)' : ''));
    }
  }

  // --- MCP servers ---
  if (Array.isArray(mcpServers) && mcpServers.length) {
    const running = mcpServers.filter(s => s.status === 'running');
    const stopped = mcpServers.filter(s => s.status === 'stopped' || s.status === 'error');
    const parts = [];
    if (running.length) parts.push(running.length + ' running');
    if (stopped.length) parts.push(stopped.length + ' stopped');
    feat.push('[MCP] ' + parts.join(', ') + ' (' + mcpServers.length + ' total)');
  }

  // --- Agent files ---
  // Resolve whether agent files are enabled (per-chat -> project -> profile default)
  let agentFilesEnabled = false;
  try {
    const agentFiles = require('./agentFiles.js');
    agentFilesEnabled = agentFiles.resolveEnabled({ chat, projectDir });
  } catch { /* safe default */ }
  if (agentFilesEnabled) {
    feat.push('[agent files] enabled — AGENTS.md / CLAUDE.md / .github/copilot-instructions.md');
  }

  // --- Project agents ---
  try {
    const agents = require('./agents.js');
    const list = agents.listPresets(projectDir);
    const selected = agents.resolveSelected({ chat, projectDir });
    if (list.length) {
      feat.push('[agents] ' + list.length + ' available' + (selected ? ' — selected ' + selected : ''));
    }
  } catch { /* safe default */ }

  // --- File tagging ---
  // Tagged files are always injected when the project has tag entries.
  // We check if any tags are configured.
  let tagsExist = false;
  try {
    const tags = require('./tags.js');
    const tagList = tags.getTags(projectDir);
    tagsExist = tagList && typeof tagList === 'object' && Object.keys(tagList).length > 0;
  } catch { /* safe default */ }
  if (tagsExist) {
    feat.push('[file tagging] active — tags found in project');
  }

  // --- Trace ---
  const traceOn = chat && chat.trace === true;
  if (traceOn) {
    feat.push('[trace] on — events written to .mouaif/traces/');
  }

  // --- Prompt profile ---
  let profileId = 'average';
  try {
    const promptProfiles = require('./promptProfiles.js');
    const profile = promptProfiles.resolveProfile({ chat, projectDir });
    if (profile && profile.id) profileId = profile.id;
  } catch { /* safe default */ }
  feat.push('[prompt profile] ' + profileId);

  if (!feat.length) return null;

  lines.push('This mouaif project has these features:');
  lines.push('');
  for (const f of feat) lines.push('- ' + f);
  lines.push('');
  lines.push('You also have a `list_features` tool available — call it to get the complete structured feature state with every detail.');

  return lines.join('\n');
}

// dispatchListFeatures(args, opts)
//
// Handler for the `list_features` tool call. Returns the full structured
// feature state as a JSON object so the model can inspect details.
async function dispatchListFeatures(args, opts) {
  const chatId = opts && opts.chatId;
  const projectDir = opts && opts.projectDir;
  // Load the chat record to inspect trace, agentFiles, promptSize, etc.
  let chat = opts && opts.chat;
  if (!chat && projectDir && chatId) {
    try {
      const chats = require('./chats.js');
      chat = chats.getChat(projectDir, chatId);
    } catch { /* safe default */ }
  }
  const result = { ok: true, content: '', result: null };

  const state = {};

  // Built-in tool authorization
  try {
    const authz = require('./tools/authorization.js');
    const authState = authz.getAuthorization(projectDir);
    const tools = (authState && authState.tools) || {};
    state.tools = {};
    for (const name of ['shell', 'subagent', 'file', 'ask_user']) {
      const cfg = tools[name] || { mode: 'ask' };
      state.tools[name] = {
        mode: cfg.mode || 'ask',
        allowlist: cfg.allowlist || [],
        defaultTimeoutMs: cfg.defaultTimeoutMs,
        maxTimeoutMs: cfg.maxTimeoutMs
      };
    }
  } catch (e) {
    state.tools = { _error: e.message };
  }

  // MCP servers
  try {
    const mcpMod = require('./mcp.js');
    const serverList = typeof mcpMod.listServers === 'function' ? mcpMod.listServers(projectDir) : [];
    if (Array.isArray(serverList)) {
      state.mcp = [];
      for (const s of serverList) {
        const entry = { name: s.name, slug: s.slug, status: s.status, tools: s.tools || [] };
        if (s.authorization) entry.authorization = s.authorization;
        state.mcp.push(entry);
      }
    }
  } catch (e) {
    state.mcp = { _error: e.message };
  }

  // Agent files
  try {
    const agentFiles = require('./agentFiles.js');
    state.agentFiles = {
      enabled: agentFiles.resolveEnabled({ chat, projectDir }),
      fileNames: agentFiles.resolveFileNames({ chat, projectDir }),
      discovered: agentFiles.discover(projectDir).map(f => ({ name: f.name, size: f.size }))
    };
  } catch (e) {
    state.agentFiles = { _error: e.message };
  }

  // Project agents
  try {
    const agents = require('./agents.js');
    state.agents = {
      selected: agents.resolveSelected({ chat, projectDir }),
      discovered: agents.listPresets(projectDir).map(a => ({ name: a.id, title: a.title }))
    };
  } catch (e) {
    state.agents = { _error: e.message };
  }

  // File tagging
  try {
    const tags = require('./tags.js');
    const tagList = tags.getTags(projectDir);
    state.fileTagging = {
      active: tagList && typeof tagList === 'object' && Object.keys(tagList).length > 0,
      count: tagList && typeof tagList === 'object' ? Object.keys(tagList).length : 0
    };
  } catch (e) {
    state.fileTagging = { _error: e.message };
  }

  // Trace
  state.trace = chat && chat.trace === true;

  // Prompt profile
  try {
    const promptProfiles = require('./promptProfiles.js');
    const profile = promptProfiles.resolveProfile({ chat, projectDir });
    state.promptProfile = profile ? { id: profile.id, label: profile.label } : null;
  } catch (e) {
    state.promptProfile = null;
  }

  result.content = JSON.stringify(state, null, 2);
  result.result = state;
  return result;
}

module.exports = {
  TOOL_NAME,
  LIST_FEATURES_SPEC,
  buildFeatureSummary,
  dispatchListFeatures
};