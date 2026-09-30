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
//     promptSnapshot, providerId, modelId, draft, tools, agentFiles,
//     skills, toolAuth }
//
// `promptSnapshot` pins the custom prompt a chat was attached to at attach
// time, so editing that prompt later never rewrites an existing chat. See
// src/prompts.js snapshotPrompt().
//
// API enrichment (added by GET /api/chats, NOT persisted):
//   { totalCost: { total, known, currency } }
const fs = require('fs');
const crypto = require('crypto');
const settings = require('./settings.js');
const messages = require('./messages.js');
const promptProfiles = require('./promptProfiles.js');
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
// Per-chat authorization overrides live directly on the chat record
// (`chat.toolAuth`), so reading them is just a getChat() — see
// `readChatAuthOverrides` in src/tools/authorization.js for the shape.

function listChats(projectDir, options) {
return getChatDb().listChats(projectDir, options);
}
function countChats(projectDir) {
return getChatDb().countChats(projectDir);
}
// searchChats(projectDir, query, { limit }) — the project card's magnifier.
// Matches chat titles, composer drafts, and message text; returns chat-list
// summaries plus `matchField` and `snippet`. See the long note in
// src/chatdb.js for why it reads message bodies one row at a time.
function searchChats(projectDir, query, options) {
if (!projectDir || typeof projectDir !== 'string') return [];
return getChatDb().searchChats(projectDir, query, options || {});
}
function getChat(projectDir, chatId) {
if (!chatId || typeof chatId !== 'string') return null;
return getChatDb().getChat(projectDir, chatId);
}
// resolvePromptSnapshot(projectDir, opts) -> snapshot | undefined
//
// The snapshot to pin on a chat when it is created or re-attached to a
// prompt. `opts.promptSnapshot` lets a caller pass one through verbatim
// (the DB import path); otherwise the prompt is read from the store now.
// A missing prompt yields undefined — the chat then has no snapshot and
// resolves live, which is the pre-snapshot behaviour.
function resolvePromptSnapshot(projectDir, opts) {
  if (opts && opts.promptSnapshot && typeof opts.promptSnapshot === 'object') {
    return opts.promptSnapshot;
  }
  const id = opts && typeof opts.promptId === 'string' ? opts.promptId : '';
  if (!id) return undefined;
  try {
    return require('./prompts.js').snapshotPrompt(projectDir, id) || undefined;
  } catch { return undefined; }
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
promptSize: opts && promptProfiles.isValidProfile(opts.promptSize) ? opts.promptSize : defaults.promptSize,
thinkingLevel: opts && typeof opts.thinkingLevel === 'string' ? opts.thinkingLevel : '',
maxOutputTokens: opts && typeof opts.maxOutputTokens === 'string' ? opts.maxOutputTokens : '',
promptId: opts && typeof opts.promptId === 'string' && opts.promptId ? opts.promptId : null,
// Pin the prompt's text at attach time (docs/features/custom-prompts.md).
// Editing the prompt afterwards must not rewrite this chat, so the text
// rides on the record from here on; `promptId` stays as provenance and as
// the fallback for chats that have no snapshot.
promptSnapshot: resolvePromptSnapshot(projectDir, opts),
skills: opts && typeof opts.skills === 'boolean' ? opts.skills : undefined,
disabledSkills: opts && Array.isArray(opts.disabledSkills) && opts.disabledSkills.length
  ? opts.disabledSkills.map((n) => String(n)).filter(Boolean)
  : undefined,
autoRetry: opts && typeof opts.autoRetry === 'boolean' ? opts.autoRetry : undefined,
// Per-chat tool authorization overrides — see updateChat below.
toolAuth: (opts && opts.toolAuth && typeof opts.toolAuth === 'object' && !Array.isArray(opts.toolAuth) && Object.keys(opts.toolAuth).length)
? opts.toolAuth
: undefined,
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
if (patch && promptProfiles.isValidProfile(patch.promptSize)) {
dbPatch.promptSize = patch.promptSize;
}
if (patch && Object.prototype.hasOwnProperty.call(patch, 'promptId')) {
dbPatch.promptId = (patch.promptId === null || patch.promptId === '') ? null : String(patch.promptId);
}
// The pinned snapshot is its own patchable field so the two intents stay
// apart: re-attaching (`promptId` set) derives a fresh snapshot, an
// explicit `promptSnapshot` (used by clearPromptId when a prompt is
// deleted) wins, and detaching (`promptId` null with no explicit
// snapshot) clears it. Without this split, deleting a prompt would wipe
// the text of every chat that had pinned it — the exact retroactive
// change the snapshot exists to prevent (src/prompts.js snapshotPrompt).
if (patch && Object.prototype.hasOwnProperty.call(patch, 'promptSnapshot')) {
dbPatch.promptSnapshot = patch.promptSnapshot && typeof patch.promptSnapshot === 'object'
  ? patch.promptSnapshot
  : null;
} else if (patch && Object.prototype.hasOwnProperty.call(patch, 'promptId')) {
dbPatch.promptSnapshot = dbPatch.promptId
  ? resolvePromptSnapshot(projectDir, { promptId: dbPatch.promptId })
  : null;
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
const attachments = messages.normalizeAttachments(patch.draftAttachments);
dbPatch.draftAttachments = attachments.length ? attachments : null;
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
// Per-skill opt-outs for this one chat. `null` (or an empty list)
// clears them; anything that is not a list is ignored so a malformed
// PATCH cannot wipe the field.
if (patch && Object.prototype.hasOwnProperty.call(patch, 'disabledSkills')) {
const list = Array.isArray(patch.disabledSkills)
? Array.from(new Set(patch.disabledSkills.map((n) => String(n)).filter(Boolean)))
: [];
dbPatch.disabledSkills = list.length ? list : null;
}
if (patch && Object.prototype.hasOwnProperty.call(patch, 'autoRetry')) {
dbPatch.autoRetry = patch.autoRetry === true;
}
// Per-chat tool authorization overrides (decisions §17). The shape is the
// structured one the authorization module owns:
//   { native: { shell: { mode, allowlist }, … },
//     mcp: { shared: …, servers: { <slug>: { mode } }, tools: { <name>: { mode } } } }
// Only `mode` (and a native `allowlist`) are persisted; everything else is
// dropped so the chat record can never accumulate arbitrary payloads. An
// empty map is stored as `null`: "no overrides" has exactly one
// representation. Anything that is not an object is ignored so a malformed
// PATCH cannot wipe the field.
if (patch && Object.prototype.hasOwnProperty.call(patch, 'toolAuth')) {
if (patch.toolAuth === null) {
dbPatch.toolAuth = undefined;
} else if (patch.toolAuth && typeof patch.toolAuth === 'object' && !Array.isArray(patch.toolAuth)) {
const next = {};
const native = (patch.toolAuth.native && typeof patch.toolAuth.native === 'object' && !Array.isArray(patch.toolAuth.native))
? patch.toolAuth.native
: {};
const nativeOut = {};
for (const [name, value] of Object.entries(native)) {
if (typeof name !== 'string' || !name) continue;
if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
if (typeof value.mode !== 'string' || !value.mode) continue;
nativeOut[name] = {
mode: value.mode,
allowlist: Array.isArray(value.allowlist) ? value.allowlist.map((p) => String(p)).filter(Boolean) : []
};
}
if (Object.keys(nativeOut).length) next.native = nativeOut;
const m = patch.toolAuth.mcp;
if (m && typeof m === 'object' && !Array.isArray(m)) {
const mcpOut = {};
if (m.shared && typeof m.shared === 'object' && typeof m.shared.mode === 'string' && m.shared.mode) {
mcpOut.shared = { mode: m.shared.mode };
}
for (const key of ['servers', 'tools']) {
const map = (m[key] && typeof m[key] === 'object' && !Array.isArray(m[key])) ? m[key] : null;
if (!map) continue;
const kept = {};
for (const [name, value] of Object.entries(map)) {
if (typeof name !== 'string' || !name) continue;
if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
if (typeof value.mode !== 'string' || !value.mode) continue;
kept[name] = { mode: value.mode };
}
if (Object.keys(kept).length) mcpOut[key] = kept;
}
if (Object.keys(mcpOut).length) next.mcp = mcpOut;
}
dbPatch.toolAuth = Object.keys(next).length ? next : undefined;
}
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
// Read the full record: the chat-list projection deliberately omits
// `promptSnapshot` (it is only needed here and by the stream path).
const full = getChat(projectDir, c.id);
// Drop the reference but KEEP the pinned text: a chat that was
// attached to this prompt keeps behaving as it always did, so deleting
// a shared prompt is not a silent behaviour change for every chat that
// used it. The snapshot was already the source of truth at stream time,
// so the chat's next turn sends exactly the same prompt as the last one.
updateChat(projectDir, c.id, {
  promptId: null,
  promptSnapshot: (full && full.promptSnapshot) || null
});
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
searchChats,
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
