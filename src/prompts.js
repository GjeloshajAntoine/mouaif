'use strict';
// Custom prompts — user-authored system prompts, stored in app SQLite or per project.
//
// Implements the "Custom prompts" feature from .github/copilot-instructions.md §4.
// Prompts can be stored globally in the app SQLite database (`prompts` key in app settings)
// or per project in `<projectDir>/.mouaif.json` under a `prompts` array.
// Project prompts take precedence over app prompts with the same id.
//
// Schema (inside app or project.prompts):
//   {
//     id:        'short-kebab-id',           // unique within the scope
//     title:     'Concise label',            // shown in the UI picker
//     icon:      'sparkles',                 // safe built-in icon key
//     showOnProjectCard: false,               // quick new-chat icon button
//     content:   'You are a helpful…',       // the prompt text
//     role:      'system',                   // locked; the field is kept
//                                            // for forward-compat and for
//                                            // hand-edits, but the editor
//                                            // and validator only accept
//                                            // 'system'. A non-system role
//                                            // would have to be prepended
//                                            // before the transcript, which
//                                            // is not the intended use.
//     preset:    { tools?: ['shell','read_file',...],
//                  agentFiles?: boolean,
//                  skills?: boolean },       // OPTIONAL chat preset: the
//                                            // starting settings of a chat
//                                            // created from this prompt.
//                                            // createChat copies them onto
//                                            // the chat (see presetSeed);
//                                            // nothing is merged per turn.
//                                            // The project's authorization
//                                            // gate still applies (off
//                                            // stays off).
//     createdAt: '2026-07-15T12:00Z',
//     updatedAt: '2026-07-15T12:00Z'
//   }
//
// Each chat can reference a prompt via its `promptId` field (see chats.js).
// At stream time, the server prepends the prompt as a `system` message
// before the user message. If the prompt carries a `preset`, a chat
// created from it starts with those tool / agent-file / skill settings
// (see presetSeed below).
const crypto = require('crypto');
const settings = require('./settings.js');
const collection = require('./content/collection.js');

// ---- Helpers ------------------------------------------------------------

function newPromptId() {
  // Kebab-case short id: 4 random hex bytes.
  return crypto.randomBytes(4).toString('hex');
}

// Only `system` is accepted. Historical projects may have prompts
// authored under a different role; normalizeChat silently coerces
// anything else to 'system' so the field stays valid.
const VALID_ROLES = new Set(['system']);
const DEFAULT_ICON = 'sparkles';
const PROMPT_ICONS = new Set(['sparkles', 'code', 'search', 'pencil', 'bug', 'book']);
function normalizeIcon(icon) {
return typeof icon === 'string' && PROMPT_ICONS.has(icon) ? icon : DEFAULT_ICON;
}
// The native tool names a prompt preset may list: the model-facing names
// the tool catalog (GET /api/tools/list) and the preset tree emit, which
// are also what the stream's per-chat filter matches. In addition, MCP
// tool ids (`mcp__<slug>__<tool>`) and a whole-server `mcp__<slug>__*`
// are accepted as-is, the same strings `chat.tools` stores.
//
// A preset only seeds the per-chat allowlist — the project's
// authorization gate (off/ask/allow) stays authoritative, so listing a
// tool here can never turn on something the project turned off.
const FILE_TOOL_NAMES = require('./tools/files.js').FILE_TOOL_NAMES;
const PRESET_TOOL_NAMES = new Set(['shell', ...FILE_TOOL_NAMES, 'subagent', ...require('./tools/subagent-orchestration.js').TOOL_NAMES, 'report_progress', 'task', 'ask_user', 'webpreview', 'restart_app', 'list_features', 'group_cli', ...require('./tools/schedule.js').NAMES, ...require('./tools/webhook.js').NAMES, ...require('./tools/hooks.js').NAMES, ...require('./tools/appToolNames.js').TOOL_NAMES]);
// `file` is the family name, not a tool the model is sent. Older presets
// may list it; it stands for every file operation.
const LEGACY_FILE_FAMILY = 'file';

// MCP tool ids in the catalog look like `mcp__<slug>__<tool>`. Anything
// starting with this prefix is accepted as a tool name in the preset,
// mirroring `chat.tools`.
const MCP_TOOL_PREFIX = 'mcp__';

// normalizePreset(raw) -> { tools, agentFiles, skills } | null
//
// A preset is an OPTIONAL attachment to a prompt. It is normalized to a
// small, stable shape:
//   - `tools` is a de-duped array of model-facing tool names — the
//     allowlist a new chat starts with (`chat.tools`). Native names from
//     PRESET_TOOL_NAMES and MCP ids are kept; the legacy `file` family
//     name expands to the file operations; anything else is dropped.
//     Absent means "every tool", like a chat with no allowlist; an
//     explicit empty list means "start with no tools". A list whose every
//     entry was dropped counts as absent, not as empty.
//   - `agentFiles` / `skills` are booleans copied onto the new chat's
//     toggles. Absent means "leave the chat default".
// Anything not an object, or with none of the three fields, collapses to
// null (treated as "no preset").
function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let tools;
  if (Array.isArray(raw.tools)) {
    const out = new Set();
    for (const t of raw.tools) {
      if (typeof t !== 'string') continue;
      if (t === LEGACY_FILE_FAMILY) { for (const n of FILE_TOOL_NAMES) out.add(n); }
      else if (PRESET_TOOL_NAMES.has(t) || t.startsWith(MCP_TOOL_PREFIX)) out.add(t);
    }
    if (out.size || !raw.tools.length) tools = Array.from(out);
  }
  const agentFiles = typeof raw.agentFiles === 'boolean' ? raw.agentFiles : undefined;
  const skills = typeof raw.skills === 'boolean' ? raw.skills : undefined;

  if (!tools && agentFiles === undefined && skills === undefined) return null;
  return {
    tools,
    agentFiles,
    skills
  };
}

function normalizePrompt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.content !== 'string' || !raw.content.trim()) return null;
  return {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : raw.id,
icon: normalizeIcon(raw.icon),
showOnProjectCard: raw.showOnProjectCard === true,
content: raw.content,
role: 'system',
preset: normalizePreset(raw.preset),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString()
  };
}

// ---- CRUD ---------------------------------------------------------------

// Storage goes through the shared collection code (src/content/collection.js):
// app prompts in the app store, project prompts in the project's settings.
function getPromptsList(projectDir) {
  return projectDir ? collection.read('prompts', 'project', projectDir) : collection.read('prompts', 'app');
}

function savePromptsList(projectDir, list) {
  return projectDir
    ? collection.replace('prompts', 'project', projectDir, list)
    : collection.replace('prompts', 'app', undefined, list);
}

function listPrompts(projectDir, opts = {}) {
  // If no projectDir is provided, returns app-level prompts with scope: 'app'.
  if (!projectDir) {
    const raw = getPromptsList('');
    const out = [];
    for (const p of raw) {
      const n = normalizePrompt(p);
      if (n) out.push({ ...n, scope: 'app' });
    }
    return out;
  }

  // If explicit scope is requested:
  if (opts && opts.scope === 'project') {
    const raw = getPromptsList(projectDir);
    const out = [];
    for (const p of raw) {
      const n = normalizePrompt(p);
      if (n) out.push({ ...n, scope: 'project' });
    }
    return out;
  }
  if (opts && opts.scope === 'app') {
    const raw = getPromptsList('');
    const out = [];
    for (const p of raw) {
      const n = normalizePrompt(p);
      if (n) out.push({ ...n, scope: 'app' });
    }
    return out;
  }

  // Merged: project prompts take precedence over app prompts with the same id.
  const appRaw = getPromptsList('');
  const projRaw = getPromptsList(projectDir);
  const out = [];
  const seenIds = new Set();

  for (const p of projRaw) {
    const n = normalizePrompt(p);
    if (n) {
      out.push({ ...n, scope: 'project' });
      seenIds.add(n.id);
    }
  }
  for (const p of appRaw) {
    const n = normalizePrompt(p);
    if (n && !seenIds.has(n.id)) {
      out.push({ ...n, scope: 'app' });
      seenIds.add(n.id);
    }
  }
  return out;
}

function getPrompt(projectDir, promptId, opts = {}) {
  if (!promptId || typeof promptId !== 'string') return null;
  return listPrompts(projectDir, opts).find(p => p.id === promptId) || null;
}

function createPrompt(projectDir, opts) {
  if (!opts || typeof opts.content !== 'string' || !opts.content.trim()) {
    const e = new Error('content is required');
    e.code = 'EBADINPUT';
    throw e;
  }
  const targetDir = (opts && opts.scope === 'app') ? '' : (projectDir || '');
  const rawList = getPromptsList(targetDir);
  const list = rawList.slice();
  const prompt = normalizePrompt({
    id: typeof opts.id === 'string' && opts.id.trim() ? opts.id.trim() : newPromptId(),
    title: typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : '',
icon: normalizeIcon(opts.icon),
showOnProjectCard: opts.showOnProjectCard === true,
content: opts.content,
role: 'system',
preset: normalizePreset(opts.preset),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  if (!prompt) {
    const e = new Error('Failed to normalize prompt');
    e.code = 'EBADINPUT';
    throw e;
  }
  list.push(prompt);
  savePromptsList(targetDir, list);
  return { ...prompt, scope: targetDir ? 'project' : 'app' };
}

function updatePrompt(projectDir, promptId, patch) {
  if (!promptId) return null;
  const targetDir = (patch && patch.scope === 'app') ? '' : (projectDir || '');
  const rawList = getPromptsList(targetDir);
  const list = rawList.slice();
  let idx = list.findIndex(p => p && p.id === promptId);
  let effectiveDir = targetDir;

  if (idx < 0 && targetDir && (!patch || !patch.scope)) {
    const appList = getPromptsList('').slice();
    const appIdx = appList.findIndex(p => p && p.id === promptId);
    if (appIdx >= 0) {
      idx = appIdx;
      effectiveDir = '';
      list.length = 0;
      list.push(...appList);
    }
  }
  if (idx < 0) return null;

  const current = normalizePrompt(list[idx]);
  if (!current) return null;
  if (patch && typeof patch.title === 'string') {
    current.title = patch.title.trim() || current.id;
  }
  if (patch && typeof patch.content === 'string' && patch.content.trim()) {
current.content = patch.content;
}
if (patch && Object.prototype.hasOwnProperty.call(patch, 'icon')) {
current.icon = normalizeIcon(patch.icon);
}
if (patch && Object.prototype.hasOwnProperty.call(patch, 'showOnProjectCard')) {
current.showOnProjectCard = patch.showOnProjectCard === true;
}
if (patch && Object.prototype.hasOwnProperty.call(patch, 'preset')) {
    current.preset = patch.preset == null ? null : normalizePreset(patch.preset);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'role') && !VALID_ROLES.has(patch.role)) {
    // no-op
  }
  current.updatedAt = new Date().toISOString();
  list[idx] = current;
  savePromptsList(effectiveDir, list);
  return { ...current, scope: effectiveDir ? 'project' : 'app' };
}

function deletePrompt(projectDir, promptId, opts) {
  if (!promptId) return false;
  const targetDir = (opts && opts.scope === 'app') ? '' : (projectDir || '');
  const rawList = getPromptsList(targetDir);
  let list = rawList.slice();
  let before = list.length;
  list = list.filter(p => p && p.id !== promptId);
  let effectiveDir = targetDir;

  if (list.length === before) {
    if (targetDir && (!opts || !opts.scope)) {
      const appRaw = getPromptsList('');
      const appList = appRaw.filter(p => p && p.id !== promptId);
      if (appList.length !== appRaw.length) {
        savePromptsList('', appList);
        if (opts && typeof opts.onRemoved === 'function') {
          try { opts.onRemoved(promptId); } catch (e) { /* swallow */ }
        }
        return true;
      }
    }
    return false;
  }

  savePromptsList(effectiveDir, list);
  if (opts && typeof opts.onRemoved === 'function') {
    try { opts.onRemoved(promptId); } catch (e) { /* swallow */ }
  }
  return true;
}

// getPromptPreset(projectDir, promptId) -> { tools, agentFiles } | null
//
// Convenience for the chat pipeline: resolves a prompt's preset without
// callers having to reach into getPrompt()'s shape. Returns null when the
// prompt is missing or carries no preset. Missing/corrupt project files
// resolve to null so a bad preset never breaks the tool loop.
function getPromptPreset(projectDir, promptId) {
  if (!promptId) return null;
  try {
    const p = getPrompt(projectDir, promptId);
    return p && p.preset ? p.preset : null;
  } catch { return null; }
}

// snapshotPrompt(projectDir, promptId) -> { title, content, role, preset? } | null
//
// The immutable copy of a prompt a chat pins when it is attached to one.
// A chat must not change behaviour because somebody edited a shared
// prompt afterwards, so the text and the preset are copied onto the chat
// record at attach time and every later read uses that copy (see
// resolveChatPrompt). `promptId` stays alongside it as provenance and as
// the fallback for chats written before snapshots existed.
//
// Returns null when the prompt is missing, so a caller can tell "nothing
// to pin" from "pinned an empty prompt".
function snapshotPrompt(projectDir, promptId) {
  if (!promptId) return null;
  try {
    const p = getPrompt(projectDir, promptId);
    if (!p || typeof p.content !== 'string' || !p.content.trim()) return null;
    const snap = { title: p.title || '', content: p.content, role: 'system' };
    if (p.preset) snap.preset = p.preset;
    return snap;
  } catch { return null; }
}

// resolveChatPrompt(projectDir, chat) -> { content, role, preset } | null
//
// The prompt a chat actually sends, preferring the pinned snapshot and
// falling back to a live lookup by `promptId`. That fallback is what
// keeps chats created before snapshots existed working, and what makes a
// missing prompt resolve to null so the stream proceeds without one.
function resolveChatPrompt(projectDir, chat) {
  if (!chat || typeof chat !== 'object') return null;
  const snap = chat.promptSnapshot;
  if (snap && typeof snap.content === 'string' && snap.content.trim()) {
    const out = { content: snap.content, role: VALID_ROLES.has(snap.role) ? snap.role : 'system' };
    if (snap.preset && typeof snap.preset === 'object') out.preset = snap.preset;
    return out;
  }
  if (!chat.promptId) return null;
  try {
    const p = getPrompt(projectDir, chat.promptId);
    if (!p || typeof p.content !== 'string' || !p.content.trim()) return null;
    const out = { content: p.content, role: p.role, preset: p.preset || null };
    return out;
  } catch { return null; }
}

// presetSeed(preset) -> { tools?, agentFiles?, skills? }
//
// The chat fields a preset sets on a chat created from its prompt (see
// chats.createChat, and chats.updateChat for attaching to an empty chat).
// Only fields the preset carries are returned, so a tools-only preset
// leaves the chat's agent-file and skill defaults alone. The chat stores
// the result, so the Tools popup shows exactly what the model gets and
// the user can change it afterwards like any other chat setting.
function presetSeed(preset) {
  const out = {};
  if (!preset || typeof preset !== 'object') return out;
  if (Array.isArray(preset.tools)) out.tools = preset.tools.slice();
  if (typeof preset.agentFiles === 'boolean') out.agentFiles = preset.agentFiles;
  if (typeof preset.skills === 'boolean') out.skills = preset.skills;
  return out;
}

module.exports = {
  newPromptId,
VALID_ROLES,
DEFAULT_ICON,
PROMPT_ICONS,
normalizeIcon,
PRESET_TOOL_NAMES,
MCP_TOOL_PREFIX,
normalizePreset,
  listPrompts,
  getPrompt,
  getPromptPreset,
  snapshotPrompt,
  resolveChatPrompt,
  presetSeed,
  createPrompt,
  updatePrompt,
  deletePrompt
};
