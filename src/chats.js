'use strict';
// Chats — per-project chat list.
//
// Chat metadata and messages are persisted in the app-level SQLite store
// (~/.mouaif/store.sqlite) via src/chatdb.js. There is no file-based chat
// storage backend anymore: `.mouaif.messages.*.json` transcripts were
// removed, and the opt-in trace-to-file export (docs/decisions.md §5) is the
// only way to commit a chat's transcript next to the project source.
//
// Each project (identified by its on-disk `projectDir`) owns a list of
// chats. The public API shape delegates to src/chatdb.js.
//
// Schema (per chat):
//   { id, title, createdAt, lastOpenedAt, trace, promptSize, promptId,
//     providerId, modelId, draft, tools, agentFiles, skills }
//
// API enrichment (added by GET /api/chats, NOT persisted):
//   { totalCost: { total, known, currency } }
const fs = require('fs');
const crypto = require('crypto');
const settings = require('./settings.js');
const PROJECT_FILE = '.mouaif.json';
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
function getChatDb() {
return require('./chatdb.js');
}
// ---- Public surface -------------------------------------------------------
function listChats(projectDir, options) {
return getChatDb().listChats(projectDir, options);
}
function countChats(projectDir) {
return getChatDb().countChats(projectDir);
}
function getChat(projectDir, chatId) {
if (!chatId || typeof chatId !== 'string') return null;
return getChatDb().getChat(projectDir, chatId);
}
function createChat(projectDir, opts) {
ensureDir(projectDir);
const resolved = settings.getResolved(projectDir);
const defaults = defaultsForProject(resolved);
const chat = {
id: newChatId(),
title: (opts && typeof opts.title === 'string' && opts.title.trim()) ? opts.title.trim() : 'New chat',
createdAt: new Date().toISOString(),
lastOpenedAt: null,
trace: opts && opts.trace === true,
promptSize: opts && ['very-small', 'average', 'extensive'].includes(opts.promptSize) ? opts.promptSize : defaults.promptSize,
thinkingLevel: opts && typeof opts.thinkingLevel === 'string' ? opts.thinkingLevel : '',
maxOutputTokens: opts && typeof opts.maxOutputTokens === 'string' ? opts.maxOutputTokens : '',
promptId: opts && typeof opts.promptId === 'string' && opts.promptId ? opts.promptId : null,
tools: opts && Array.isArray(opts.tools) ? opts.tools : undefined
};
return getChatDb().createChat(projectDir, chat);
}
function updateChat(projectDir, chatId, patch) {
if (!chatId) return null;
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
if (patch && Object.prototype.hasOwnProperty.call(patch, 'draftAttachments')) {
  dbPatch.draftAttachments = Array.isArray(patch.draftAttachments) && patch.draftAttachments.length ? patch.draftAttachments : null;
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
function deleteChat(projectDir, chatId) {
if (!chatId) return false;
return getChatDb().deleteChat(projectDir, chatId);
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
function chatTotalCost(projectDir, chatId) {
const chat = getChat(projectDir, chatId);
return chat && chat.totalCost
? { total: chat.totalCost.total, known: chat.totalCost.known, currency: 'USD' }
: { total: 0, known: false, currency: 'USD' };
}
function recomputeProjectTotalCost(projectDir) {
const db = getChatDb();
const totals = db.projectCostTotals(projectDir);
let total = 0;
let knownCount = 0;
for (const chat of listChats(projectDir)) {
const cost = totals[chat.id] || { total: 0, known: false, knownCount: 0 };
db.updateChat(projectDir, chat.id, {
totalCost: {
total: cost.total,
known: cost.known,
currency: 'USD',
knownCount: cost.knownCount || 0
}
});
total += cost.total;
knownCount += cost.knownCount || 0;
}
const out = { total, known: knownCount > 0, currency: 'USD', knownCount };
try { require('./projects.js').setProjectTotalCost(projectDir, out); } catch { /* non-fatal */ }
return out;
}
module.exports = {
PROJECT_FILE,
listChats,
countChats,
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
