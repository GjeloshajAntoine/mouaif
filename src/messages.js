'use strict';

// Messages — per-chat transcript.
//
// Each chat (identified by its project directory + chat id) owns a
// transcript of user / assistant / system / tool messages. Messages
// are persisted in a per-chat file:
//
//   <projectDir>/.mouaif.messages.<chatId>.json
//
// One file per chat (rather than a `messages` array on the chat
// record in <projectDir>/.mouaif.json) keeps each project file small
// and avoids an unbounded array growing inside the JSON file. The
// file is rewritten in full on every write — messages are append-mostly
// in practice, and a rewrite is cheap for the expected transcript
// sizes (hundreds of messages, not millions).
//
// Schema:
//
//   {
//     messages: [
//       { role: 'user' | 'assistant' | 'system' | 'tool',
//         content: 'string',
//         attachments?: [{ type: 'image', mimeType, dataUrl, name? }],
//         ts: '2026-07-14T12:34:00.000Z' },
//       ...
//     ]
//   }

const path = require('path');
const settings = require('./settings.js');

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
  if (m.role === 'user') {
    const attachments = normalizeAttachments(m.attachments);
    if (attachments.length) out.attachments = attachments;
  }
  // The assistant message is the only one that carries usage + cost
  // (decision §14). We persist them on the message itself so a chat
  // reopened later shows the same numbers that were on screen when
  // the message was produced. The cost block is optional and may be
  // absent on older transcripts.
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

// Read/write the per-chat messages file through the shared helpers in
// settings.js so the on-disk format (2-space JSON + trailing LF) and the
// corrupt-file contract (MOUAIF_PROJECT_PARSE_ERROR) match the rest of the
// project files. A missing transcript resolves to { messages: [] }.
function readRaw(projectDir, chatId) {
  const file = messagesFilePath(projectDir, chatId);
  return settings.readProjectJson(file, { messages: [] });
}

function writeRaw(projectDir, chatId, obj) {
  const file = messagesFilePath(projectDir, chatId);
  settings.writeProjectJson(file, obj);
}

function listMessages(projectDir, chatId) {
  const raw = readRaw(projectDir, chatId);
  const list = Array.isArray(raw.messages) ? raw.messages : [];
  const out = [];
  for (const m of list) {
    const n = normalizeMessage(m);
    if (n) out.push(n);
  }
  return out;
}

function getMessage(projectDir, chatId, index) {
  if (typeof index !== 'number' || index < 0) return null;
  return listMessages(projectDir, chatId)[index] || null;
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
  const stored = listMessages(projectDir, chatId);
  const ts = typeof msg.ts === 'string' ? msg.ts : new Date().toISOString();
  const normalized = { role: msg.role, content: msg.content, ts };
  // Same enrichment as normalizeMessage. The setter path and the
  // loader path share the same shape so a chat that is appended to
  // and then re-loaded never loses its cost / usage fields.
  if (msg.role === 'user') {
    const attachments = normalizeAttachments(msg.attachments);
    if (attachments.length) normalized.attachments = attachments;
  }
  if (msg.role === 'assistant') {
    if (msg.usage && typeof msg.usage === 'object') normalized.usage = msg.usage;
    if (msg.cost && typeof msg.cost === 'object') normalized.cost = msg.cost;
    if (typeof msg.streamingMs === 'number') normalized.streamingMs = msg.streamingMs;
    if (typeof msg.modelId === 'string') normalized.modelId = msg.modelId;
  }
  if (msg.role === 'tool') {
    if (typeof msg.toolCallId === 'string') normalized.toolCallId = msg.toolCallId;
    if (typeof msg.name === 'string') normalized.name = msg.name;
    if (msg.args && typeof msg.args === 'object') normalized.args = msg.args;
    if (typeof msg.ok === 'boolean') normalized.ok = msg.ok;
    if (typeof msg.phase === 'string') normalized.phase = msg.phase;
  }
  stored.push(normalized);
  writeRaw(projectDir, chatId, { messages: stored });
  return normalized;
}

function replaceMessages(projectDir, chatId, list) {
  if (!Array.isArray(list)) throw new TypeError('list must be an array');
  const out = [];
  for (const m of list) {
    const n = normalizeMessage(m);
    if (n) out.push(n);
  }
  writeRaw(projectDir, chatId, { messages: out });
  return out;
}

function clearMessages(projectDir, chatId) {
  const before = listMessages(projectDir, chatId).length;
  writeRaw(projectDir, chatId, { messages: [] });
  return before;
}

// Convert the persisted transcript into the OpenAI-shaped history used by
// the provider clients. Tool records are written as adjacent call/result
// pairs. A process stop, aborted request, or closed browser can leave the
// final call without its result; forwarding that orphan makes strict
// OpenAI-compatible providers reject the next user turn with HTTP 400.
//
// Only complete adjacent pairs are reconstructed. Historical call ids are
// also canonicalized when missing, duplicated, or unusually long. The ids
// are conversation-local correlation keys, so replacing one on both sides
// of a stored pair preserves its meaning while keeping the next request
// portable across OpenAI-shaped providers.
function reconstructUpstreamHistory(list, contentForMessage, options) {
  const source = Array.isArray(list) ? list : [];
  const contentOf = typeof contentForMessage === 'function'
    ? contentForMessage
    : (m) => m && m.content;
  const includeTools = !options || options.includeTools !== false;
  const out = [];
  const usedIds = new Set();
  let pairNumber = 0;

  for (let i = 0; i < source.length; i++) {
    const m = source[i];
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'tool') {
      if (!includeTools) continue;
      if (m.phase !== 'call') continue; // orphan result or unknown phase
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
      out.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: wireId, type: 'function', function: { name, arguments: args } }]
      });
      out.push({
        role: 'tool',
        tool_call_id: wireId,
        name,
        content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content || {})
      });
      i++; // consume the paired result
      continue;
    }

    out.push({ role: m.role, content: contentOf(m) });
  }
  return out;
}

module.exports = {
  VALID_ROLES,
  CHAT_ID_RE,
  normalizeAttachments,
  assertChatId,
  messagesFilePath,
  listMessages,
  getMessage,
  appendMessage,
  replaceMessages,
  clearMessages,
  reconstructUpstreamHistory
};
