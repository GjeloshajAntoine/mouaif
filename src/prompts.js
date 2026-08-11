'use strict';

// Custom prompts — user-authored system prompts, stored per project.
//
// Implements the "Custom prompts" feature from .github/copilot-instructions.md §4.
// Prompts live in `<projectDir>/.mouaif.json` under a `prompts` array, so they
// can be committed to the repo and edited by hand alongside project settings.
//
// Schema (inside project.prompts):
//   {
//     id:        'short-kebab-id',           // unique within the project
//     title:     'Concise label',            // shown in the UI picker
//     content:   'You are a helpful…',       // the prompt text
//     role:      'system',                   // locked; the field is kept
//                                            // for forward-compat and for
//                                            // hand-edits, but the editor
//                                            // and validator only accept
//                                            // 'system'. A non-system role
//                                            // would have to be prepended
//                                            // before the transcript, which
//                                            // is not the intended use.
//     preset:    { tools?: ['shell','file',...],
//                  agentFiles?: boolean,
//                  skills?: boolean },       // OPTIONAL chat preset: when a
//                                            // chat references this prompt,
//                                            // these tool + agent-file
//                                            // settings apply to that chat.
//                                            // See server-handlers-chats.js
//                                            // resolveChatPreset. The preset
//                                            // only *enables* a tool via the
//                                            // per-chat allowlist and turns
//                                            // agent files / skills on — it
//                                            // never overrides the project's
//                                            // authorization gate (off stays
//                                            // off).
//     createdAt: '2026-07-15T12:00Z',
//     updatedAt: '2026-07-15T12:00Z'
//   }
//
// Each chat can reference a prompt via its `promptId` field (see chats.js).
// At stream time, the server prepends the prompt as a `system` message
// before the user message. If the prompt carries a `preset`, the chat's
// tool / agent-file settings also pick it up (see below).

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

// The native tool *family* names a prompt preset may list. In addition
// to these, MCP model-facing tool ids (e.g. `mcp__<slug>__<tool>`) are
// accepted as-is — the same strings the chat's per-chat tool allowlist
// stores and that the tool catalog advertises. The preset union-merges
// them onto `chat.tools`, matching the chat's allowlist semantics.
//
// The preset only manipulates the per-chat allowlist — the project's
// authorization gate (off/ask/allow for `file`, `shell`, …) stays
// authoritative, so listing a tool here can never turn on something
// the project turned off.
const PRESET_TOOL_NAMES = new Set(['shell', 'file', 'subagent', 'report_progress', 'task', 'ask_user']);
// MCP tool ids in the catalog look like `mcp__<slug>__<tool>`. Anything
// starting with this prefix is accepted as a tool name in the preset,
// mirroring `chat.tools`.
const MCP_TOOL_PREFIX = 'mcp__';

// normalizePreset(raw) -> { tools, agentFiles, skills } | null
//
// A preset is an OPTIONAL attachment to a prompt. It is normalized to a
// small, stable shape:
//   - `tools` is a de-duped array of model-facing tool names — the same
//     names the chat's per-chat tool allowlist (`chat.tools`) stores.
//     Native family names (shell, file, subagent, report_progress, task,
//     ask_user) and MCP tool ids (`mcp__<slug>__<tool>`) are both
//     accepted. Anything else is dropped. An empty array means "this
//     preset grants no additional tools" — equivalent to omitting the
//     field, but kept when the user explicitly cleared it.
//   - `agentFiles` is a boolean: when true the chat referencing this
//     prompt turns agent-file injection on.
//   - `skills` is a boolean: when true the chat referencing this prompt
//     turns skill injection on. Matches the per-chat `skills` toggle and
//     the project-level `skills` lock.
// Anything not an object, or with none of the three fields, collapses to
// null (treated as "no preset").
function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tools = Array.isArray(raw.tools)
    ? Array.from(new Set(raw.tools
        .filter((t) => typeof t === 'string' && (PRESET_TOOL_NAMES.has(t) || t.startsWith(MCP_TOOL_PREFIX)))
        .map((t) => t)))
    : undefined;
  const agentFiles = typeof raw.agentFiles === 'boolean' ? raw.agentFiles : undefined;
  const skills = typeof raw.skills === 'boolean' ? raw.skills : undefined;
  if ((!tools || !tools.length) && agentFiles === undefined && skills === undefined) return null;
  return {
    tools: tools || undefined,
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
    content: raw.content,
    role: 'system',
    preset: normalizePreset(raw.preset),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString()
  };
}

// ---- CRUD ---------------------------------------------------------------

function listPrompts(projectDir) {
  const project = settings.getProject(projectDir);
  const raw = Array.isArray(project.prompts) ? project.prompts : [];
  const out = [];
  for (const p of raw) {
    const n = normalizePrompt(p);
    if (n) out.push(n);
  }
  return out;
}

function getPrompt(projectDir, promptId) {
  if (!promptId || typeof promptId !== 'string') return null;
  return listPrompts(projectDir).find(p => p.id === promptId) || null;
}

function createPrompt(projectDir, opts) {
  if (!opts || typeof opts.content !== 'string' || !opts.content.trim()) {
    const e = new Error('content is required');
    e.code = 'EBADINPUT';
    throw e;
  }
  const project = settings.getProject(projectDir);
  const list = Array.isArray(project.prompts) ? project.prompts.slice() : [];
  const prompt = normalizePrompt({
    id: newPromptId(),
    title: typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : '',
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
  settings.setProject(projectDir, { prompts: list });
  return prompt;
}

function updatePrompt(projectDir, promptId, patch) {
  if (!promptId) return null;
  const project = settings.getProject(projectDir);
  const list = Array.isArray(project.prompts) ? project.prompts.slice() : [];
  const idx = list.findIndex(p => p && p.id === promptId);
  if (idx < 0) return null;
  const current = normalizePrompt(list[idx]);
  if (!current) return null;
  if (patch && typeof patch.title === 'string') {
    current.title = patch.title.trim() || current.id;
  }
  if (patch && typeof patch.content === 'string' && patch.content.trim()) {
    current.content = patch.content;
  }
  // `preset` accepts an object (set/overwrite), null/undefined (clear), or
  // an explicit { preset: null } to remove the preset entirely. Absent key
  // leaves it untouched so PATCH stays partial.
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'preset')) {
    current.preset = patch.preset == null ? null : normalizePreset(patch.preset);
  }
  // role is locked to 'system'. Accept and ignore any patch.role so a
  // hand-edited .mouaif.json with a non-system role round-trips safely.
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'role') && !VALID_ROLES.has(patch.role)) {
    // no-op
  }
  current.updatedAt = new Date().toISOString();
  list[idx] = current;
  settings.setProject(projectDir, { prompts: list });
  return current;
}

function deletePrompt(projectDir, promptId, opts) {
  if (!promptId) return false;
  const project = settings.getProject(projectDir);
  if (!Array.isArray(project.prompts)) return false;
  const before = project.prompts.length;
  project.prompts = project.prompts.filter(p => p && p.id !== promptId);
  if (project.prompts.length === before) return false;
  settings.setProject(projectDir, { prompts: project.prompts });
  // Optional post-delete hook. The HTTP handler passes a function that
  // cascade-clears `promptId` on every chat in the project so a chat
  // never carries a dangling reference. Hooks are only invoked when a
  // prompt was actually removed.
  if (opts && typeof opts.onRemoved === 'function') {
    try { opts.onRemoved(promptId); }
    catch (e) { /* swallow; the prompt is gone either way */ }
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
  if (!projectDir || !promptId) return null;
  try {
    const p = getPrompt(projectDir, promptId);
    return p && p.preset ? p.preset : null;
  } catch { return null; }
}

// effectivePresetConfig(chat, preset) -> { tools?, agentFiles?, skills? }
//
// Merge a prompt's preset onto a chat's own per-chat config. Returns a
// partial update object the chat pipeline reads as the effective values.
//
// Tools are ADDITIVE, never downgrading: a chat with no per-chat
// allowlist already inherits every project tool, so emitting the preset's
// list here would silently restrict the chat to just those tools — the
// opposite of "enable". Only when the chat already restricts its tools
// does the preset union its list in. Absent preset fields are ignored, so
// a preset granting only tools leaves the chat's agentFiles untouched and
// vice-versa.
//
// The preset is a convenience layer over the existing per-chat settings —
// it never relaxes the project's authorization gate (a tool the project
// turned `off` stays off; agent files and skills silently follow the
// project lock).
function effectivePresetConfig(chat, preset) {
  const out = {};
  if (chat && typeof chat === 'object' && preset && typeof preset === 'object') {
    if (Array.isArray(preset.tools)) {
      // Merge ONLY onto an existing per-chat allowlist. `chat.tools`
      // being undefined means "all project tools" — leave it that way.
      if (Array.isArray(chat.tools)) {
        out.tools = Array.from(new Set(chat.tools.concat(preset.tools)));
      }
    }
    if (typeof preset.agentFiles === 'boolean') out.agentFiles = preset.agentFiles;
    if (typeof preset.skills === 'boolean') out.skills = preset.skills;
  }
  return out;
}

module.exports = {
  newPromptId,
  VALID_ROLES,
  PRESET_TOOL_NAMES,
  MCP_TOOL_PREFIX,
  normalizePreset,
  listPrompts,
  getPrompt,
  getPromptPreset,
  effectivePresetConfig,
  createPrompt,
  updatePrompt,
  deletePrompt
};