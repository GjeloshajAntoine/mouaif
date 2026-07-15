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
//     createdAt: '2026-07-15T12:00Z',
//     updatedAt: '2026-07-15T12:00Z'
//   }
//
// Each chat can reference a prompt via its `promptId` field (see chats.js).
// At stream time, the server prepends the prompt as a `system` message
// before the user message.

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

function normalizePrompt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.content !== 'string' || !raw.content.trim()) return null;
  return {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : raw.id,
    content: raw.content,
    role: 'system',
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

module.exports = {
  newPromptId,
  VALID_ROLES,
  listPrompts,
  getPrompt,
  createPrompt,
  updatePrompt,
  deletePrompt
};