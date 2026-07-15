'use strict';

// Chats — per-project chat list.
//
// Each project (identified by its on-disk `projectDir`) owns a list of
// chats. Chats are persisted in `<projectDir>/.mouaif.json` under a
// `chats` array, alongside the rest of the project-level settings.
//
// A chat in this commit is a thin record. It exists so the project card
// in the mobile UI can render a chat list and a "New chat" button. The
// chat message history itself is not stored here — that lands with a
// separate chat data store commit. Per docs/decisions.md §5, the only
// per-chat fields the trace-to-file commit needs to read are `id` and
// `trace`; the project card commit adds the per-chat `promptSize` so
// the chat list can show which profile each chat is using.
//
// Schema (per chat, inside project.chats):
//   {
//     id:           '8-char-hex',         // unique within the project
//     title:        'New chat',           // user-editable later
//     createdAt:    '2026-07-14T12:34Z',  // ISO 8601
//     lastOpenedAt: undefined,            // set when the chat is opened
//     trace:        false,                // per-chat trace-to-file override
//     promptSize:   'average',            // per-chat prompt-size profile
//     promptId:     null                  // optional; references a project prompt
//   }
//
// New chats always start with tracing off unless the creation request
// explicitly opts in (decision §5). `promptSize` inherits from resolved
// project settings, falling back to the app-level default.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings.js');

const PROJECT_FILE = '.mouaif.json';

function projectFilePath(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('projectDir must be a non-empty string');
  }
  return path.join(projectDir, PROJECT_FILE);
}

function readProject(projectDir) {
  const file = projectFilePath(projectDir);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    const err = new Error('Failed to parse ' + file + ': ' + e.message);
    err.code = 'MOUAIF_PROJECT_PARSE_ERROR';
    throw err;
  }
}

function writeProject(projectDir, obj) {
  const file = projectFilePath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function newChatId() {
  return crypto.randomBytes(4).toString('hex'); // 8 hex chars
}

function defaultsForProject(project) {
  return {
    promptSize: (project && project.promptSize) || 'average'
  };
}

function normalizeChat(chat) {
  if (!chat || typeof chat !== 'object') return null;
  if (!chat.id || typeof chat.id !== 'string') return null;
  return {
    id: chat.id,
    title: typeof chat.title === 'string' ? chat.title : 'New chat',
    createdAt: chat.createdAt || new Date().toISOString(),
    lastOpenedAt: chat.lastOpenedAt || null,
    trace: chat.trace === true,
    promptSize: ['very-small', 'average', 'extensive'].includes(chat.promptSize) ? chat.promptSize : 'average',
    promptId: typeof chat.promptId === 'string' && chat.promptId ? chat.promptId : null
  };
}

// ---- Public surface ---------------------------------------------------

// List chats for a project. Returns an array (possibly empty). Throws
// MOUAIF_PROJECT_PARSE_ERROR if the project file is corrupt.
function listChats(projectDir) {
  const project = readProject(projectDir);
  const raw = Array.isArray(project.chats) ? project.chats : [];
  const out = [];
  for (const c of raw) {
    const n = normalizeChat(c);
    if (n) out.push(n);
  }
  return out;
}

function getChat(projectDir, chatId) {
  if (!chatId || typeof chatId !== 'string') return null;
  return listChats(projectDir).find(c => c.id === chatId) || null;
}

// Create a new chat in the project. Returns the new chat record.
// Reads the project file, appends to project.chats (creating the file
// and the chats key if needed), and writes the file back. The new chat's
// `promptSize` is seeded from project-level settings via
// settings.getResolved(projectDir) (decisions §2: defaults -> app ->
// project). Trace is off unless opts.trace explicitly enables it.
function createChat(projectDir, opts) {
  ensureDir(projectDir);
  const project = readProject(projectDir);
  const resolved = settings.getResolved(projectDir);
  const defaults = defaultsForProject(resolved);
  const chat = normalizeChat({
    id: newChatId(),
    title: (opts && typeof opts.title === 'string' && opts.title.trim()) ? opts.title.trim() : 'New chat',
    createdAt: new Date().toISOString(),
    lastOpenedAt: null,
    trace: opts && opts.trace === true,
    promptSize: opts && ['very-small', 'average', 'extensive'].includes(opts.promptSize) ? opts.promptSize : defaults.promptSize
  });
  if (!project.chats) project.chats = [];
  project.chats.push(chat);
  writeProject(projectDir, project);
  return chat;
}

// Update a chat's fields. Only the whitelisted fields are written.
// Returns the updated chat, or null if the chat doesn't exist.
function updateChat(projectDir, chatId, patch) {
  if (!chatId) return null;
  const project = readProject(projectDir);
  const idx = Array.isArray(project.chats) ? project.chats.findIndex(c => c && c.id === chatId) : -1;
  if (idx < 0) return null;
  const current = normalizeChat(project.chats[idx]);
  const merged = Object.assign({}, current, normalizeChat(Object.assign({}, current, patch)));
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'title')) {
    const t = String(patch.title).trim();
    if (t) merged.title = t;
  }
  if (patch && typeof patch.trace === 'boolean') merged.trace = patch.trace;
  if (patch && ['very-small', 'average', 'extensive'].includes(patch.promptSize)) merged.promptSize = patch.promptSize;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'promptId')) {
    merged.promptId = (patch.promptId === null || patch.promptId === '') ? null : String(patch.promptId);
  }
  project.chats[idx] = merged;
  writeProject(projectDir, project);
  return merged;
}

// Delete a chat. Returns true if a chat was removed, false if not found.
function deleteChat(projectDir, chatId) {
  if (!chatId) return false;
  const project = readProject(projectDir);
  if (!Array.isArray(project.chats)) return false;
  const before = project.chats.length;
  project.chats = project.chats.filter(c => c && c.id !== chatId);
  if (project.chats.length === before) return false;
  writeProject(projectDir, project);
  return true;
}

// Touch lastOpenedAt to "now". Returns the updated chat or null.
function touchChat(projectDir, chatId) {
  return updateChat(projectDir, chatId, { lastOpenedAt: new Date().toISOString() });
}

// Cascade-clear `promptId` on every chat in the project that references
// the given prompt id. Called when a prompt is deleted, so a chat that
// used to inject the prompt no longer carries a dangling reference.
// Returns the number of chats updated. No-op if the project file has
// no chats or no matching reference.
function clearPromptId(projectDir, promptId) {
  if (!projectDir || !promptId) return 0;
  let project;
  try { project = readProject(projectDir); }
  catch (e) {
    if (e.code === 'MOUAIF_PROJECT_PARSE_ERROR') throw e;
    return 0;
  }
  if (!Array.isArray(project.chats) || !project.chats.length) return 0;
  let changed = 0;
  for (let i = 0; i < project.chats.length; i++) {
    const c = project.chats[i];
    if (c && c.promptId === promptId) {
      project.chats[i] = Object.assign({}, c, { promptId: null });
      changed++;
    }
  }
  if (changed > 0) writeProject(projectDir, project);
  return changed;
}

module.exports = {
  // introspection
  PROJECT_FILE,
  // list / get
  listChats,
  getChat,
  // mutate
  createChat,
  updateChat,
  deleteChat,
  touchChat,
  clearPromptId
};
