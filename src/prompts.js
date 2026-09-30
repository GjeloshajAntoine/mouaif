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
//     preset:    { disabledTools?: ['shell','group_edit',...],
//                  agentFiles?: true,
//                  skills?: true },          // OPTIONAL chat preset. The
//                                            // listed tools start switched
//                                            // off in a chat created from
//                                            // this prompt (the user can
//                                            // tick them again in the chat);
//                                            // agentFiles / skills turn those
//                                            // features on. See
//                                            // presetChatTools and
//                                            // effectivePresetConfig. The
//                                            // project's authorization gate
//                                            // stays authoritative.
//     createdAt: '2026-07-15T12:00Z',
//     updatedAt: '2026-07-15T12:00Z'
//   }
//
// Each chat can reference a prompt via its `promptId` field (see chats.js).
// At stream time, the server prepends the prompt as a `system` message
// before the user message. If the prompt carries a `preset`, the chat's
// tool list is restricted when it is attached, and agent files / skills
// are turned on at stream time (see below).
const crypto = require('crypto');
const settings = require('./settings.js');

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
// Model-facing tool names a preset may disable. A preset is RESTRICTIVE:
// `disabledTools` lists the tools a chat attached to this prompt starts
// with switched off (see presetChatTools). The names are the same strings
// the chat's per-chat allowlist (`chat.tools`) and the tool catalog use —
// individual file operations (`read_file`, `group_edit`, …), native tools
// (`shell`, `task`, …) and MCP tool ids (`mcp__<slug>__<tool>`). A family
// name such as `file` would match nothing in the stream's exact-name
// filter, so it is not accepted.
const NATIVE_PRESET_TOOL_NAMES = ['shell', 'subagent', 'report_progress', 'task', 'ask_user', 'webpreview', 'restart_app'];
function fileToolNames() {
  try { return require('./tools/files.js').FILE_TOOL_NAMES.slice(); } catch { return []; }
}
const PRESET_TOOL_NAMES = new Set(NATIVE_PRESET_TOOL_NAMES.concat(fileToolNames()));

// MCP tool ids in the catalog look like `mcp__<slug>__<tool>`. Anything
// starting with this prefix is accepted, mirroring `chat.tools`.
const MCP_TOOL_PREFIX = 'mcp__';

// normalizePreset(raw) -> { disabledTools?, agentFiles?, skills? } | null
//
// A preset is an OPTIONAL attachment to a prompt, normalized to:
//   - `disabledTools`: de-duped tool names (see PRESET_TOOL_NAMES) that a
//     chat attached to this prompt starts with switched off. Unknown names
//     are dropped. Empty -> omitted.
//   - `agentFiles: true` / `skills: true`: the preset turns agent-file /
//     skill injection ON for chats using the prompt. A preset only ever
//     turns these on, so `false` is treated as "not set" and dropped —
//     an untouched checkbox must never switch a chat's feature off.
// The legacy `tools` allowlist (the old additive shape) is dropped: it
// never restricted anything and its file-tool names were lost anyway.
// A preset with nothing left collapses to null ("no preset").
function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const disabledTools = Array.isArray(raw.disabledTools)
    ? Array.from(new Set(raw.disabledTools.filter((t) => typeof t === 'string'
      && (PRESET_TOOL_NAMES.has(t) || t.startsWith(MCP_TOOL_PREFIX)))))
    : [];
  const out = {};
  if (disabledTools.length) out.disabledTools = disabledTools;
  if (raw.agentFiles === true) out.agentFiles = true;
  if (raw.skills === true) out.skills = true;
  return Object.keys(out).length ? out : null;
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

function getPromptsList(projectDir) {
  if (projectDir) {
    const project = settings.getProject(projectDir);
    return Array.isArray(project.prompts) ? project.prompts : [];
  }
  const app = settings.getApp();
  return Array.isArray(app.prompts) ? app.prompts : [];
}

function savePromptsList(projectDir, list) {
  if (projectDir) {
    settings.setProject(projectDir, { prompts: list });
  } else {
    settings.setApp({ prompts: list });
  }
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
    // Re-normalize: a snapshot pinned before presets were restrictive may
    // carry the old `{ tools, agentFiles: false }` shape, whose `false`
    // must not switch the chat's features off.
    const preset = normalizePreset(snap.preset);
    if (preset) out.preset = preset;
    return out;
  }
  if (!chat.promptId) return null;
  try {
    const p = getPrompt(projectDir, chat.promptId);
    if (!p || typeof p.content !== 'string' || !p.content.trim()) return null;
    return { content: p.content, role: p.role, preset: p.preset || null };
  } catch { return null; }
}

// effectivePresetConfig(chat, preset) -> { agentFiles?, skills? }
//
// The part of a preset that applies per stream turn, merged in memory onto
// the chat (the persisted record is never modified). It can only turn
// agent files and skills ON; the project locks (`agentFiles: false`,
// `skills: false`) are read after the merge and still win, and a chat's
// per-skill opt-outs (`disabledSkills`) still apply.
//
// Tools are NOT merged here: a preset's `disabledTools` is applied once,
// when the prompt is attached (presetChatTools), so the user can tick a
// tool back on in the chat's Tools card and have it stick.
function effectivePresetConfig(chat, preset) {
  const out = {};
  if (chat && typeof chat === 'object' && preset && typeof preset === 'object') {
    if (preset.agentFiles === true) out.agentFiles = true;
    if (preset.skills === true) out.skills = true;
  }
  return out;
}

// knownToolNames(projectDir) -> string[]
//
// Every model-facing tool name a chat can be offered in this project: the
// native tools, each file operation, `list_features`, and the MCP tools
// (live or cached). Used to turn a chat's implicit "all tools" (`tools`
// unset) into an explicit allowlist when a preset switches some off.
function knownToolNames(projectDir) {
  const names = NATIVE_PRESET_TOOL_NAMES.concat(['list_features'], fileToolNames());
  if (projectDir) {
    try {
      for (const s of (require('./mcp.js').listComposedToolSpecs(projectDir) || [])) {
        if (s && s.name) names.push(s.name);
      }
    } catch { /* no MCP tools */ }
  }
  return Array.from(new Set(names));
}

// presetChatTools(projectDir, chatTools, preset) -> string[] | undefined
//
// The per-chat tool allowlist for a chat that is being attached to a
// prompt: its current list (or every known tool when it has none) minus
// the preset's `disabledTools`. Returns undefined when the preset disables
// nothing, meaning "leave `chat.tools` as it is". The result is written
// onto the chat record, so the chat's Tools card shows those tools
// unticked and the user can tick them again.
function presetChatTools(projectDir, chatTools, preset) {
  const disabled = preset && Array.isArray(preset.disabledTools) ? preset.disabledTools : [];
  if (!disabled.length) return undefined;
  const off = new Set(disabled);
  const base = Array.isArray(chatTools) ? chatTools : knownToolNames(projectDir);
  return base.filter((n) => !off.has(n));
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
  snapshotPrompt,
  resolveChatPrompt,
  effectivePresetConfig,
  knownToolNames,
  presetChatTools,
  createPrompt,
  updatePrompt,
  deletePrompt
};
