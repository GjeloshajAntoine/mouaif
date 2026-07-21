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
// the chat list can show which profile each chat is using; the chat
// list cost-summary commit (this one) adds a `totalCost` block on the
// API response (NOT persisted on the chat record — the source of truth
// is the per-assistant-message `cost` field in the messages file).
//
// Schema (per chat, inside project.chats):
//   {
//     id:           '8-char-hex',         // unique within the project
//     title:        'New chat',           // user-editable later
//     createdAt:    '2026-07-14T12:34Z',  // ISO 8601
//     lastOpenedAt: undefined,            // set when the chat is opened
//     trace:        false,                // per-chat trace-to-file override
//     promptSize:   'average',            // per-chat prompt-size profile
//     promptId:     null,                 // optional; references a project prompt
//     providerId:   null,                 // selected app-level provider
//     modelId:      null,                 // selected project/live model slug
//     draft:        '',                   // unsent composer text
//     tools:        undefined | null | [name], // per-chat tool filter; absent/null = all
//     agentFiles:   undefined | true | false   // per-chat agent-file toggle; absent = profile default
//     skills:       undefined | true | false   // per-chat skill toggle; absent = profile default
//   }
//
// API enrichment (added by GET /api/chats, NOT persisted on disk):
//   {
//     ...persisted fields...,
//     totalCost: { total: <USD>, known: <bool>, currency: 'USD' }
//   }
//
// New chats always start with tracing off unless the creation request
// explicitly opts in (decision §5). `promptSize` inherits from resolved
// project settings, falling back to the app-level default.

const fs = require('fs');
const crypto = require('crypto');
const settings = require('./settings.js');
const { CHAT_ID_RE, listMessages } = require('./messages.js');

const PROJECT_FILE = '.mouaif.json';

function projectFilePath(projectDir) {
  // settings.getProjectPath enforces the same non-empty-string contract
  // and is the single source of truth for the <projectDir>/.mouaif.json path.
  return settings.getProjectPath(projectDir);
}

// Read/write the project file through the shared helpers in settings.js so
// the on-disk format (2-space JSON + trailing LF) and the corrupt-file
// contract (MOUAIF_PROJECT_PARSE_ERROR) live in one place.
function readProject(projectDir) {
  return settings.readProjectJson(projectFilePath(projectDir));
}

function writeProject(projectDir, obj) {
  settings.writeProjectJson(projectFilePath(projectDir), obj);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function newChatId() {
  return crypto.randomBytes(4).toString('hex'); // 8 hex chars
}

function titleFromPrompt(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'New chat';
  const max = 60;
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/[\s.,;:!?\-–—]+$/g, '') + '…';
}

function isDefaultTitle(title) {
  const t = String(title || '').trim();
  return !t || t === 'New chat';
}

function defaultsForProject(project) {
  return {
    promptSize: (project && project.promptSize) || 'average'
  };
}

function normalizeChat(chat) {
  if (!chat || typeof chat !== 'object') return null;
  if (!chat.id || typeof chat.id !== 'string' || !CHAT_ID_RE.test(chat.id)) return null;
  // The `tools` filter is intentionally NOT normalized to a default
  // value here. Distinguishing `undefined`/`null` ("all tools") from
  // `[]` ("explicitly no tools") is load-bearing for the AI client:
  // the former advertises the full project catalog, the latter
  // advertises nothing. A persisted `[]` must round-trip as `[]`.
  return {
    id: chat.id,
    title: typeof chat.title === 'string' ? chat.title : 'New chat',
    createdAt: chat.createdAt || new Date().toISOString(),
    lastOpenedAt: chat.lastOpenedAt || null,
    trace: chat.trace === true,
    promptSize: ['very-small', 'average', 'extensive'].includes(chat.promptSize) ? chat.promptSize : 'average',
    promptId: typeof chat.promptId === 'string' && chat.promptId ? chat.promptId : null,
    providerId: typeof chat.providerId === 'string' && chat.providerId ? chat.providerId : null,
    modelId: typeof chat.modelId === 'string' && chat.modelId ? chat.modelId : null,
    draft: typeof chat.draft === 'string' ? chat.draft : '',
    tools: chat.tools === null ? null : (Array.isArray(chat.tools) ? chat.tools.map((n) => String(n)).filter(Boolean) : undefined),
    agentFiles: typeof chat.agentFiles === 'boolean' ? chat.agentFiles : undefined,
    skills: typeof chat.skills === 'boolean' ? chat.skills : undefined
  };
}

// ---- In-memory cache (TTL-based) ---------------------------------------
const LIST_CACHE_TTL = 2000; // ms
const COST_CACHE_TTL = 5000; // ms
const _listCache = new Map(); // projectDir -> { at: ms, data: [...] }
const _costCache = new Map(); // projectDir::chatId -> { at: ms, data: {...} }

function cacheGet(map, key, ttl) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ttl) { map.delete(key); return null; }
  return entry.data;
}

function cacheSet(map, key, data) {
  map.set(key, { at: Date.now(), data });
}

function invalidateChatListCache(projectDir) {
  _listCache.delete(projectDir);
  // Also clear per-chat cost entries for this project since they reference
  // the same chat list data that may have changed.
  for (const k of _costCache.keys()) {
    if (k.startsWith(projectDir + '::')) _costCache.delete(k);
  }
}

function invalidateChatCostCache(projectDir, chatId) {
  _costCache.delete(projectDir + '::' + chatId);
}

// ---- Public surface ---------------------------------------------------

// List chats for a project. Returns an array (possibly empty). Throws
// MOUAIF_PROJECT_PARSE_ERROR if the project file is corrupt.
function listChats(projectDir) {
  const cached = cacheGet(_listCache, projectDir, LIST_CACHE_TTL);
  if (cached) return cached;
  const project = readProject(projectDir);
  const raw = Array.isArray(project.chats) ? project.chats : [];
  const out = [];
  for (const c of raw) {
    const n = normalizeChat(c);
    if (n) out.push(n);
  }
  cacheSet(_listCache, projectDir, out);
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
  const id = newChatId();

  const chat = normalizeChat({
    id,
    title: (opts && typeof opts.title === 'string' && opts.title.trim()) ? opts.title.trim() : 'New chat',
    createdAt: new Date().toISOString(),
    lastOpenedAt: null,
    trace: opts && opts.trace === true,
    promptSize: opts && ['very-small', 'average', 'extensive'].includes(opts.promptSize) ? opts.promptSize : defaults.promptSize,
    tools: opts && Array.isArray(opts.tools) ? opts.tools : undefined
  });
  if (!project.chats) project.chats = [];
  project.chats.push(chat);
  writeProject(projectDir, project);
  invalidateChatListCache(projectDir);
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
  const previousTools = current.tools;
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
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'providerId')) {
    merged.providerId = (patch.providerId === null || patch.providerId === '') ? null : String(patch.providerId);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'modelId')) {
    merged.modelId = (patch.modelId === null || patch.modelId === '') ? null : String(patch.modelId);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'draft')) {
    merged.draft = typeof patch.draft === 'string' ? patch.draft : '';
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'tools')) {
    // `null` means "all tools"; `[]` means "advertise no tools".
    // Arrays are normalized to strings so the AI client can build a
    // Set from them cheaply.
    if (patch.tools === null) {
      merged.tools = null;
    } else if (Array.isArray(patch.tools)) {
      merged.tools = patch.tools.map((n) => String(n)).filter(Boolean);
    } else {
      // Reject non-array values (objects, numbers, booleans, etc.)
      // by restoring the persisted value. The Object.assign above
      // has already overwritten the slot via normalizeChat (which
      // folds anything non-array to undefined), so previousTools is
      // the only surviving copy of the real pre-patch state.
      merged.tools = previousTools;
    }
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'agentFiles')) {
    // `undefined` / `null` means "use the profile default"; a boolean
    // pins the chat to an explicit choice.
    merged.agentFiles = (patch.agentFiles === null || patch.agentFiles === undefined)
      ? undefined
      : patch.agentFiles === true;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'skills')) {
    // `undefined` / `null` means "use the profile default"; a boolean
    // pins the chat to an explicit choice.
    merged.skills = (patch.skills === null || patch.skills === undefined)
      ? undefined
      : patch.skills === true;
  }
  project.chats[idx] = merged;
  writeProject(projectDir, project);
  invalidateChatListCache(projectDir);
  invalidateChatCostCache(projectDir, chatId);
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
  invalidateChatListCache(projectDir);
  invalidateChatCostCache(projectDir, chatId);
  return true;
}

// Touch lastOpenedAt to "now". Returns the updated chat or null.
function touchChat(projectDir, chatId) {
  return updateChat(projectDir, chatId, { lastOpenedAt: new Date().toISOString() });
}

// Set the chat title from the first user prompt, but only while the
// title is still the untouched default. Manual renames are preserved.
function titleChatFromPrompt(projectDir, chatId, content) {
  if (!chatId) return null;
  const title = titleFromPrompt(content);
  if (isDefaultTitle(title)) return null;
  const project = readProject(projectDir);
  const idx = Array.isArray(project.chats) ? project.chats.findIndex(c => c && c.id === chatId) : -1;
  if (idx < 0) return null;
  const current = normalizeChat(project.chats[idx]);
  if (!current || !isDefaultTitle(current.title)) return current;
  const merged = Object.assign({}, current, { title });
  project.chats[idx] = merged;
  writeProject(projectDir, project);
  invalidateChatListCache(projectDir);
  return merged;
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

// Sum the per-message cost (decision §14) across every assistant
// message in the chat. Returns
//   { total: <USD>, known: <bool>, currency: 'USD' }
// where `known` is true when at least one assistant message carried
// a `cost` block — i.e. the upstream reported usage and the model
// had resolvable pricing. A chat with no assistant messages (or a
// chat whose transcript is missing / unreadable) is reported as
// `{ total: 0, known: false }` so the UI can render `--` cleanly
// instead of `$0.00` — `0` is a meaningful number for a chat that
// actually has assistant messages, but is misleading for a brand
// new chat.
//
// `app` is the resolved app-level settings object (settings.getApp()),
// passed in by the caller so we don't re-fetch on every chat.
//
// Pricing for messages that *do* have a `cost` block is already
// baked into the persisted value (the cost was computed at streaming
// time using resolvePricing), so this function does NOT re-resolve
// pricing — it just sums. The only reason to look at pricing again
// is the `known` flag, which is set by the streaming layer when the
// cost was actually computed.
function chatTotalCost(projectDir, chatId, app) {
  const cacheKey = projectDir + '::' + chatId;
  const cached = cacheGet(_costCache, cacheKey, COST_CACHE_TTL);
  if (cached) return cached;
  const out = { total: 0, known: false, currency: 'USD' };
  if (!projectDir || !chatId) return out;
  let msgs;
  try { msgs = listMessages(projectDir, chatId); }
  catch (e) {
    // A corrupt messages file shouldn't take down the whole chat
    // list. Surface as "unknown" so the UI can show `--` and the
    // user can still open the chat to see the messages.
    if (e && e.code === 'MOUAIF_PROJECT_PARSE_ERROR') return out;
    return out;
  }
  let total = 0;
  let any = false;
  for (const m of msgs) {
    if (!m || m.role !== 'assistant' || !m.cost || typeof m.cost !== 'object') continue;
    const t = Number(m.cost.total);
    if (isFinite(t) && t >= 0) {
      total += t;
      any = true;
    }
  }
  out.total = total;
  out.known = any;
  void app;
  cacheSet(_costCache, cacheKey, out);
  return out;
}

// Recompute the project's total cost by summing every chat's per-message
// cost, then persist the result to the project file so GET /api/chats can
// read it without re-scanning every messages file. Returns the same shape
// as chatTotalCost: { total, known, currency }.
function recomputeProjectTotalCost(projectDir) {
  const project = readProject(projectDir);
  const chats = Array.isArray(project.chats) ? project.chats : [];
  let total = 0;
  let hasKnown = false;
  for (const c of chats) {
    if (!c || !c.id) continue;
    let tc;
    try { tc = chatTotalCost(projectDir, c.id, null); }
    catch { tc = { total: 0, known: false, currency: 'USD' }; }
    if (tc.known && typeof tc.total === 'number' && tc.total >= 0) {
      total += tc.total;
      hasKnown = true;
    }
  }
  const out = { total, known: hasKnown, currency: 'USD' };
  project.totalCost = out;
  writeProject(projectDir, project);
  return out;
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
  titleChatFromPrompt,
  clearPromptId,
  // metrics
  chatTotalCost,
  recomputeProjectTotalCost
};
