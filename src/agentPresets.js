'use strict';

// Agent presets — named bundles that combine a custom prompt, a tool
// filter, and per-skill selection into a single reusable profile.
//
// A preset is stored in `<projectDir>/.mouaif.json` under a `presets`
// array. Each chat can reference a preset via its `presetId` field;
// when the chat streams, the server resolves the preset and applies
// its promptId, enabledTools, and selectedSkills to the upstream
// message array. The user can also "apply" a preset to a chat,
// which copies the preset's values into the chat record directly.
//
// Schema (inside project.presets):
//   {
//     id:        'short-kebab-id',           // unique within the project
//     title:     'Code reviewer',             // display label
//     promptId:  null | string,               // references a project prompt (custom prompt)
//     enabledTools: null | string[],          // tool filter (null = all, array = exact set)
//     selectedSkills: null | string[],        // skill names to enable (null = all discovered, [] = none)
//     createdAt: '2026-07-15T12:00Z',
//     updatedAt: '2026-07-15T12:00Z'
//   }

const crypto = require('crypto');
const settings = require('./settings.js');
const skills = require('./skills.js');
const prompts = require('./prompts.js');

// ---- Helpers ------------------------------------------------------------

function newPresetId() {
  return crypto.randomBytes(4).toString('hex');
}

function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : raw.id,
    promptId: typeof raw.promptId === 'string' ? raw.promptId : null,
    enabledTools: raw.enabledTools === null ? null : (Array.isArray(raw.enabledTools) ? raw.enabledTools.map(String).filter(Boolean) : null),
    selectedSkills: raw.selectedSkills === null ? null : (Array.isArray(raw.selectedSkills) ? raw.selectedSkills.map(String).filter(Boolean) : null),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString()
  };
}

// ---- CRUD ---------------------------------------------------------------

function listPresets(projectDir) {
  const project = settings.getProject(projectDir);
  const raw = Array.isArray(project.presets) ? project.presets : [];
  const out = [];
  for (const p of raw) {
    const n = normalizePreset(p);
    if (n) out.push(n);
  }
  return out;
}

function getPreset(projectDir, presetId) {
  if (!presetId || typeof presetId !== 'string') return null;
  return listPresets(projectDir).find(p => p.id === presetId) || null;
}

function createPreset(projectDir, opts) {
  if (!opts || typeof opts.title !== 'string' || !opts.title.trim()) {
    const e = new Error('title is required');
    e.code = 'EBADINPUT';
    throw e;
  }
  const project = settings.getProject(projectDir);
  const list = Array.isArray(project.presets) ? project.presets.slice() : [];
  const preset = normalizePreset({
    id: newPresetId(),
    title: opts.title.trim(),
    promptId: typeof opts.promptId === 'string' ? opts.promptId : null,
    enabledTools: Array.isArray(opts.enabledTools) ? opts.enabledTools.map(String).filter(Boolean) : (opts.enabledTools === null ? null : undefined),
    selectedSkills: Array.isArray(opts.selectedSkills) ? opts.selectedSkills.map(String).filter(Boolean) : (opts.selectedSkills === null ? null : undefined),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  if (!preset) {
    const e = new Error('Failed to normalize preset');
    e.code = 'EBADINPUT';
    throw e;
  }
  list.push(preset);
  settings.setProject(projectDir, { presets: list });
  return preset;
}

function updatePreset(projectDir, presetId, patch) {
  if (!presetId) return null;
  const project = settings.getProject(projectDir);
  const list = Array.isArray(project.presets) ? project.presets.slice() : [];
  const idx = list.findIndex(p => p && p.id === presetId);
  if (idx < 0) return null;
  const current = normalizePreset(list[idx]);
  if (!current) return null;
  if (patch && typeof patch.title === 'string') {
    current.title = patch.title.trim() || current.id;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'promptId')) {
    current.promptId = typeof patch.promptId === 'string' ? patch.promptId : null;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'enabledTools')) {
    current.enabledTools = Array.isArray(patch.enabledTools) ? patch.enabledTools.map(String).filter(Boolean) : null;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'selectedSkills')) {
    current.selectedSkills = Array.isArray(patch.selectedSkills) ? patch.selectedSkills.map(String).filter(Boolean) : null;
  }
  current.updatedAt = new Date().toISOString();
  list[idx] = current;
  settings.setProject(projectDir, { presets: list });
  return current;
}

function deletePreset(projectDir, presetId, opts) {
  if (!presetId) return false;
  const project = settings.getProject(projectDir);
  if (!Array.isArray(project.presets)) return false;
  const before = project.presets.length;
  project.presets = project.presets.filter(p => p && p.id !== presetId);
  if (project.presets.length === before) return false;
  settings.setProject(projectDir, { presets: project.presets });
  if (opts && typeof opts.onRemoved === 'function') {
    try { opts.onRemoved(presetId); } catch { /* swallow */ }
  }
  return true;
}

// ---- Apply preset to a chat --------------------------------------------
//
// applyPreset({ projectDir, presetId, chat })
//   -> { promptId, enabledTools, selectedSkills }
//
// Resolves the preset and validates its references (prompt must exist,
// skill names must be discoverable). Returns the three field values
// so the caller can PATCH the chat record. Returns null if the preset
// does not exist.
//
// The resolved values are the preset's own fields — not merged with
// the chat's existing values. Missing/null means "no override" for
// that dimension.
function applyPreset({ projectDir, presetId, chat } = {}) {
  if (!presetId || !projectDir) return null;
  const preset = getPreset(projectDir, presetId);
  if (!preset) return null;
  const out = {
    promptId: preset.promptId,
    enabledTools: preset.enabledTools,
    selectedSkills: preset.selectedSkills
  };
  // Validate prompt reference.
  if (out.promptId) {
    const p = prompts.getPrompt(projectDir, out.promptId);
    if (!p) out.promptId = null; // stale reference; clear silently
  }
  // Validate skill references: only keep names that actually exist.
  if (Array.isArray(out.selectedSkills) && out.selectedSkills.length) {
    const known = new Set(skills.discover(projectDir).map(s => s.name));
    out.selectedSkills = out.selectedSkills.filter(n => known.has(n));
  }
  return out;
}

// ---- Resolve effective values from preset + chat record -----------------
//
// resolvePresetFields({ projectDir, chat })
//   -> { promptId, enabledTools, selectedSkills }
//
// If the chat has a presetId, resolve that preset and merge its fields
// over the chat's own settings. Chat-level fields win over preset fields
// when both are explicitly set (chat.promptId overrides preset.promptId,
// etc.). This lets the user apply a preset and then tweak individual
// dimensions without losing the preset association.
function resolvePresetFields({ projectDir, chat } = {}) {
  const out = { promptId: null, enabledTools: null, selectedSkills: null };
  if (!chat || !projectDir) return out;

  // Start with preset values if one is set.
  if (chat.presetId) {
    const applied = applyPreset({ projectDir, presetId: chat.presetId, chat });
    if (applied) {
      out.promptId = applied.promptId;
      out.enabledTools = applied.enabledTools;
      out.selectedSkills = applied.selectedSkills;
    }
  }

  // Chat-level overrides: only override if the chat has an explicit value.
  // For promptId, any truthy string counts as override.
  if (chat.promptId && typeof chat.promptId === 'string') {
    out.promptId = chat.promptId;
  }
  if (Array.isArray(chat.enabledTools)) {
    out.enabledTools = chat.enabledTools.map(String).filter(Boolean);
  }
  if (chat.selectedSkills === null) {
    out.selectedSkills = null;
  } else if (Array.isArray(chat.selectedSkills)) {
    out.selectedSkills = chat.selectedSkills.map(String).filter(Boolean);
  }

  return out;
}

module.exports = {
  listPresets,
  getPreset,
  createPreset,
  updatePreset,
  deletePreset,
  applyPreset,
  resolvePresetFields,
  normalizePreset,
  newPresetId
};