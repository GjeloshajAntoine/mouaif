'use strict';
// Messages — per-chat transcript.
//
// Each chat (identified by its project directory + chat id) owns a
// transcript of user / assistant / system / tool messages. Messages are
// persisted in the app-level SQLite store (~/.mouaif/store.sqlite) via
// src/chatdb.js. The legacy file backend (`.mouaif.messages.<chatId>.json`)
// was removed; opt-in commit history is available through the per-chat
// trace-to-file export (docs/decisions.md §5).
//
// Schema (per message):
//   { role, content, ts, attachments?, reasoning?, usage?, cost?,
//     streamingMs?, modelId?, toolCallId?, name?, args?, ok?, phase? }
const path = require('path');
const toolFeedback = require('./toolFeedback.js');
const CHAT_ID_RE = /^[a-f0-9]{8}$/i;
function assertChatId(chatId) {
if (!chatId || typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) {
const e = new Error('chatId must be an 8-character hexadecimal id');
e.code = 'EBADINPUT';
throw e;
}
return chatId;
}
function messagesFilePath(projectDir, chatId) {
if (!projectDir || typeof projectDir !== 'string') {
throw new TypeError('projectDir must be a non-empty string');
}
assertChatId(chatId);
return path.join(projectDir, '.mouaif.messages.' + chatId + '.json');
}
const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const MAX_IMAGE_ATTACHMENTS = 8;
const MAX_IMAGE_DATA_URL_CHARS = 12 * 1024 * 1024;
function normalizeAttachments(list) {
if (!Array.isArray(list)) return [];
const out = [];
for (const a of list) {
if (!a || typeof a !== 'object') continue;
if (a.type !== 'image') continue;
const mimeType = typeof a.mimeType === 'string' ? a.mimeType : '';
const dataUrl = typeof a.dataUrl === 'string' ? a.dataUrl : '';
if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mimeType)) continue;
if (!dataUrl.startsWith('data:' + mimeType + ';base64,')) continue;
if (dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) continue;
const item = { type: 'image', mimeType, dataUrl };
if (typeof a.name === 'string' && a.name) item.name = a.name.slice(0, 160);
out.push(item);
if (out.length >= MAX_IMAGE_ATTACHMENTS) break;
}
return out;
}
function normalizeMessage(m) {
if (!m || typeof m !== 'object') return null;
if (!VALID_ROLES.has(m.role)) return null;
if (typeof m.content !== 'string') return null;
const out = {
role: m.role,
content: m.content,
ts: typeof m.ts === 'string' ? m.ts : new Date().toISOString()
};
// Preserve a previously-assigned seq (appended rows carry one).
if (typeof m.seq === 'number' && Number.isFinite(m.seq)) out.seq = m.seq;
if (m.role === 'user') {
const attachments = normalizeAttachments(m.attachments);
if (attachments.length) out.attachments = attachments;
}
if (m.role === 'assistant') {
if (typeof m.reasoning === 'string') out.reasoning = m.reasoning;
if (m.usage && typeof m.usage === 'object') out.usage = m.usage;
if (m.cost && typeof m.cost === 'object') out.cost = m.cost;
if (typeof m.streamingMs === 'number') out.streamingMs = m.streamingMs;
if (typeof m.modelId === 'string') out.modelId = m.modelId;
}
if (m.role === 'tool') {
if (typeof m.toolCallId === 'string') out.toolCallId = m.toolCallId;
if (typeof m.name === 'string') out.name = m.name;
if (m.args && typeof m.args === 'object') out.args = m.args;
if (typeof m.ok === 'boolean') out.ok = m.ok;
if (typeof m.phase === 'string') out.phase = m.phase;
}
return out;
}
function getChatDb() {
return require('./chatdb.js');
}
// ---- Public surface -------------------------------------------------------
function listMessages(projectDir, chatId) {
return getChatDb().listMessages(projectDir, chatId);
}
function getMessage(projectDir, chatId, index) {
if (typeof index !== 'number' || index < 0) return null;
return listMessages(projectDir, chatId)[index] || null;
}
// messageCursor(projectDir, chatId) -> { nextSeq }
//
// Cheap append-only recovery cursor for a chat transcript. `nextSeq` is
// the first persisted row the client may not have yet; if the client
// already knows the same value, there is no tail to fetch. This keeps
// streaming recovery keyed on stable message seq instead of a fuzzy
// count/timestamp revision marker.
function messageCursor(projectDir, chatId) {
return getChatDb().messageCursorDb(projectDir, chatId);
}
function appendMessage(projectDir, chatId, msg) {
if (!msg || typeof msg !== 'object') {
throw new TypeError('msg must be an object');
}
if (!VALID_ROLES.has(msg.role)) {
throw new TypeError('msg.role must be one of user | assistant | system | tool');
}
if (typeof msg.content !== 'string') {
throw new TypeError('msg.content must be a string');
}
const normalized = normalizeMessage(msg);
if (!normalized) {
throw new TypeError('msg could not be normalized');
}
return getChatDb().appendMessage(projectDir, chatId, normalized);
}
function replaceMessages(projectDir, chatId, list) {
if (!Array.isArray(list)) throw new TypeError('list must be an array');
const out = [];
for (const m of list) {
const n = normalizeMessage(m);
if (n) out.push(n);
}
return getChatDb().replaceMessages(projectDir, chatId, out);
}
function clearMessages(projectDir, chatId) {
return getChatDb().clearMessages(projectDir, chatId);
}
// ---- Reconstruct upstream history (unchanged) -----------------------------
function reconstructUpstreamHistory(list, contentForMessage, options) {
const source = Array.isArray(list) ? list : [];
const contentOf = typeof contentForMessage === 'function'
? contentForMessage
: (m) => m && m.content;
const includeTools = !options || options.includeTools !== false;
const toolFeedbackMaxBytes = options && options.toolFeedbackMaxBytes;
const toolOutput = options && options.toolOutput;
const out = [];
const usedIds = new Set();
let pairNumber = 0;
for (let i = 0; i < source.length; i++) {
const m = source[i];
if (!m || typeof m !== 'object') continue;
if (m.role === 'tool') {
if (!includeTools) continue;
if (m.phase !== 'call') continue;
const result = source[i + 1];
if (!result || result.role !== 'tool' || result.phase !== 'result') continue;
const callId = typeof m.toolCallId === 'string' ? m.toolCallId : '';
const resultId = typeof result.toolCallId === 'string' ? result.toolCallId : '';
if (callId !== resultId) continue;
pairNumber++;
let wireId = callId;
if (!/^[A-Za-z0-9_-]{1,40}$/.test(wireId) || usedIds.has(wireId)) {
wireId = 'call_history_' + pairNumber.toString(36);
}
while (usedIds.has(wireId)) {
pairNumber++;
wireId = 'call_history_' + pairNumber.toString(36);
}
usedIds.add(wireId);
let args = '{}';
try { args = JSON.stringify(m.args || {}); } catch { /* keep empty object */ }
const name = m.name || result.name || 'tool';
const storedContent = typeof result.content === 'string' ? result.content : JSON.stringify(result.content || {});
let storedResult = null;
try { storedResult = JSON.parse(storedContent); } catch { /* plain-text result */ }
// During the live tool loop, explanatory text and tool_calls share
// one assistant message. Persistence keeps the text as a separate UI
// segment immediately before the call card; merge that segment back
// on replay so resumed chats serialize the same provider-cache prefix.
const previous = out[out.length - 1];
const mergePreviousAssistant = previous && previous.role === 'assistant'
&& !previous.tool_calls && typeof previous.content === 'string' && previous.content.trim();
if (mergePreviousAssistant) out.pop();
out.push({
role: 'assistant',
content: mergePreviousAssistant ? previous.content : null,
tool_calls: [{ id: wireId, type: 'function', function: { name, arguments: args } }]
});
out.push({
role: 'tool', tool_call_id: wireId, name,
content: toolFeedback.compactToolFeedback({
name, content: storedContent, result: storedResult, maxBytes: toolFeedbackMaxBytes, toolOutput
})
});
i++;
continue;
}
const content = contentOf(m);
if (m.role === 'assistant' && (content == null || (typeof content === 'string' && !content.trim()))) {
continue;
}
out.push({ role: m.role, content });
}
return out;
}
module.exports = {
VALID_ROLES,
CHAT_ID_RE,
normalizeAttachments,
normalizeMessage,
assertChatId,
messagesFilePath,
listMessages,
getMessage,
messageCursor,
appendMessage,
replaceMessages,
clearMessages,
reconstructUpstreamHistory
};
