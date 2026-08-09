'use strict';

// Chats — per-project chat list.
//
// Routes to the active storage backend based on the app-level
// `chatStorage` setting:
//   - 'db'  (default) → delegates to src/chatdb.js (SQLite)
//   - 'json'          → uses the legacy file-based store (<projectDir>/.mouaif.json)
//
// Each project (identified by its on-disk `projectDir`) owns a list of
// chats. The public API shape is identical for both backends.
//
// Schema (per chat):
//   { id, title, createdAt, lastOpenedAt, trace, promptSize, promptId,
//     providerId, modelId, draft, tools, agentFiles, skills }
//
// API enrichment (added by GET /api/chats, NOT persisted):
//   { totalCost: { total, known, currency } }
//
// See docs/decisions.md §5 for trace-to-file design.

const fs = require('fs');
const crypto = require('crypto');
const settings = require('./settings.js');
const { CHAT_ID_RE, listMessages } = require('./messages.js');

const PROJECT_FILE = '.mouaif.json';

function projectFilePath(projectDir) {
  return settings.getProjectPath(projectDir);
}

// ---- File-based helpers (legacy) ------------------------------------------

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
    thinkingLevel: typeof chat.thinkingLevel === 'string' ? chat.thinkingLevel : '',
    maxOutputTokens: typeof chat.maxOutputTokens === 'string' ? chat.maxOutputTokens : '',
    draft: typeof chat.draft === 'string' ? chat.draft : '',
    tools: chat.tools === null ? null : (Array.isArray(chat.tools) ? chat.tools.map((n) => String(n)).filter(Boolean) : undefined),
    agentFiles: typeof chat.agentFiles === 'boolean' ? chat.agentFiles : undefined,
    skills: typeof chat.skills === 'boolean' ? chat.skills : undefined
  };
}

// ---- In-memory cache (TTL-based, file backend only) -----------------------

const LIST_CACHE_TTL = 2000;
const COST_CACHE_TTL = 5000;
const _listCache = new Map();
const _costCache = new Map();

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
  for (const k of _costCache.keys()) {
    if (k.startsWith(projectDir + '::')) _costCache.delete(k);
  }
}

function invalidateChatCostCache(projectDir, chatId) {
  _costCache.delete(projectDir + '::' + chatId);
}

// ---- Storage backend selection --------------------------------------------

function useDb(projectDir) {
  try {
    const resolved = settings.getResolved(projectDir);
    return resolved.chatStorage === 'db';
  } catch {
    return false;
  }
}

function getChatDb() {
  return require('./chatdb.js');
}

// ---- Public surface -------------------------------------------------------

function listChats(projectDir) {
  if (useDb(projectDir)) {
    return getChatDb().listChats(projectDir);
  }
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
  if (useDb(projectDir)) {
    return getChatDb().getChat(projectDir, chatId);
  }
  return listChats(projectDir).find(c => c.id === chatId) || null;
}

function createChat(projectDir, opts) {
  ensureDir(projectDir);
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
    thinkingLevel: opts && typeof opts.thinkingLevel === 'string' ? opts.thinkingLevel : '',
    maxOutputTokens: opts && typeof opts.maxOutputTokens === 'string' ? opts.maxOutputTokens : '',
    tools: opts && Array.isArray(opts.tools) ? opts.tools : undefined
  });

  if (useDb(projectDir)) {
    return getChatDb().createChat(projectDir, chat);
  }

  const project = readProject(projectDir);
  if (!project.chats) project.chats = [];
  project.chats.push(chat);
  writeProject(projectDir, project);
  invalidateChatListCache(projectDir);
  return chat;
}

function updateChat(projectDir, chatId, patch) {
  if (!chatId) return null;
  if (useDb(projectDir)) {
    // Build a normalized patch object for the DB backend.
    const dbPatch = {};
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'title')) {
      const t = String(patch.title).trim();
      if (t) dbPatch.title = t;
    }
    if (patch && typeof patch.trace === 'boolean') dbPatch.trace = patch.trace;
    if (patch && ['very-small', 'average', 'extensive'].includes(patch.promptSize)) dbPatch.promptSize = patch.promptSize;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'promptId')) {
      dbPatch.promptId = (patch.promptId === null || patch.promptId === '') ? null : String(patch.promptId);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'providerId')) {
      dbPatch.providerId = (patch.providerId === null || patch.providerId === '') ? null : String(patch.providerId);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'modelId')) {
      dbPatch.modelId = (patch.modelId === null || patch.modelId === '') ? null : String(patch.modelId);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'thinkingLevel')) {
      dbPatch.thinkingLevel = typeof patch.thinkingLevel === 'string' ? patch.thinkingLevel : '';
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'maxOutputTokens')) {
      dbPatch.maxOutputTokens = typeof patch.maxOutputTokens === 'string' ? patch.maxOutputTokens : '';
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'draft')) {
      dbPatch.draft = typeof patch.draft === 'string' ? patch.draft : '';
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'tools')) {
      if (patch.tools === null) {
        dbPatch.tools = null;
      } else if (Array.isArray(patch.tools)) {
        dbPatch.tools = patch.tools.map((n) => String(n)).filter(Boolean);
      }
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'agentFiles')) {
      dbPatch.agentFiles = (patch.agentFiles === null || patch.agentFiles === undefined)
        ? undefined
        : patch.agentFiles === true;
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'skills')) {
      dbPatch.skills = (patch.skills === null || patch.skills === undefined)
        ? undefined
        : patch.skills === true;
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'lastOpenedAt')) {
      dbPatch.lastOpenedAt = patch.lastOpenedAt;
    }
    return getChatDb().updateChat(projectDir, chatId, dbPatch);
  }

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
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'thinkingLevel')) {
    merged.thinkingLevel = typeof patch.thinkingLevel === 'string' ? patch.thinkingLevel : '';
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'maxOutputTokens')) {
    merged.maxOutputTokens = typeof patch.maxOutputTokens === 'string' ? patch.maxOutputTokens : '';
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'draft')) {
    merged.draft = typeof patch.draft === 'string' ? patch.draft : '';
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'tools')) {
    if (patch.tools === null) {
      merged.tools = null;
    } else if (Array.isArray(patch.tools)) {
      merged.tools = patch.tools.map((n) => String(n)).filter(Boolean);
    } else {
      merged.tools = previousTools;
    }
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'agentFiles')) {
    merged.agentFiles = (patch.agentFiles === null || patch.agentFiles === undefined)
      ? undefined
      : patch.agentFiles === true;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'skills')) {
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

function deleteChat(projectDir, chatId) {
  if (!chatId) return false;
  if (useDb(projectDir)) {
    return getChatDb().deleteChat(projectDir, chatId);
  }
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

function touchChat(projectDir, chatId) {
  return updateChat(projectDir, chatId, { lastOpenedAt: new Date().toISOString() });
}

function titleChatFromPrompt(projectDir, chatId, content) {
  if (!chatId) return null;
  const title = titleFromPrompt(content);
  if (isDefaultTitle(title)) return null;
  const current = getChat(projectDir, chatId);
  if (!current || !isDefaultTitle(current.title)) return current;
  return updateChat(projectDir, chatId, { title });
}

function clearPromptId(projectDir, promptId) {
  if (!projectDir || !promptId) return 0;
  const chats = listChats(projectDir);
  let changed = 0;
  for (const c of chats) {
    if (c.promptId === promptId) {
      updateChat(projectDir, c.id, { promptId: null });
      changed++;
    }
  }
  return changed;
}

function chatTotalCost(projectDir, chatId, app) {
  if (useDb(projectDir)) {
    // Single indexed SQL aggregation — avoids a full listMessages
    // (which on a long tool-heavy transcript reads every row just to
    // sum a handful of assistant cost blocks).
    const agg = getChatDb().chatTotalCostDb(projectDir, chatId);
    void app;
    return { total: agg.total, known: agg.known, currency: 'USD' };
  }

  const cacheKey = projectDir + '::' + chatId;
  const cached = cacheGet(_costCache, cacheKey, COST_CACHE_TTL);
  if (cached) return cached;
  const out = { total: 0, known: false, currency: 'USD' };
  if (!projectDir || !chatId) return out;
  let msgs;
  try { msgs = listMessages(projectDir, chatId); }
  catch (e) {
    if (e && e.code === 'MOUAIF_PROJECT_PARSE_ERROR') return out;
    return out;
  }
  let total = 0;
  let any = false;
  for (const m of msgs) {
    if (!m || m.role !== 'assistant' || !m.cost || typeof m.cost !== 'object') continue;
    if (m.cost.known !== true) continue;
    const t = Number(m.cost.total);
    if (isFinite(t) && t >= 0) { total += t; any = true; }
  }
  out.total = total;
  out.known = any;
  void app;
  cacheSet(_costCache, cacheKey, out);
  return out;
}

function recomputeProjectTotalCost(projectDir) {
  if (useDb(projectDir)) {
    // One GROUP BY scan over the whole project's message store instead
    // of a full listMessages per chat (166 ms -> ~5 ms on a large
    // project with long transcripts).
    const totals = getChatDb().projectCostTotals(projectDir);
    let total = 0;
    let hasKnown = false;
    for (const chatId of Object.keys(totals)) {
      const t = totals[chatId];
      if (t.known && typeof t.total === 'number' && t.total >= 0) {
        total += t.total;
        hasKnown = true;
      }
    }
    const out = { total, known: hasKnown, currency: 'USD' };
    try {
      const project = readProject(projectDir);
      project.totalCost = out;
      writeProject(projectDir, project);
    } catch { /* non-fatal */ }
    return out;
  }

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
  PROJECT_FILE,
  listChats,
  getChat,
  createChat,
  updateChat,
  deleteChat,
  touchChat,
  titleChatFromPrompt,
  clearPromptId,
  chatTotalCost,
  recomputeProjectTotalCost
};