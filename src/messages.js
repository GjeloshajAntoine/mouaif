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
//         ts: '2026-07-14T12:34:00.000Z' },
//       ...
//     ]
//   }

const fs = require('fs');
const path = require('path');

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

function normalizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  if (!VALID_ROLES.has(m.role)) return null;
  if (typeof m.content !== 'string') return null;
  const out = {
    role: m.role,
    content: m.content,
    ts: typeof m.ts === 'string' ? m.ts : new Date().toISOString()
  };
  // The assistant message is the only one that carries usage + cost
  // (decision §14). We persist them on the message itself so a chat
  // reopened later shows the same numbers that were on screen when
  // the message was produced. The cost block is optional and may be
  // absent on older transcripts.
  if (m.role === 'assistant') {
    if (m.usage && typeof m.usage === 'object') out.usage = m.usage;
    if (m.cost && typeof m.cost === 'object') out.cost = m.cost;
    if (typeof m.streamingMs === 'number') out.streamingMs = m.streamingMs;
    if (typeof m.modelId === 'string') out.modelId = m.modelId;
  }
  return out;
}

function readRaw(projectDir, chatId) {
  const file = messagesFilePath(projectDir, chatId);
  if (!fs.existsSync(file)) return { messages: [] };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    const err = new Error('Failed to parse ' + file + ': ' + e.message);
    err.code = 'MOUAIF_PROJECT_PARSE_ERROR';
    throw err;
  }
}

function writeRaw(projectDir, chatId, obj) {
  const file = messagesFilePath(projectDir, chatId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
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
  if (msg.role === 'assistant') {
    if (msg.usage && typeof msg.usage === 'object') normalized.usage = msg.usage;
    if (msg.cost && typeof msg.cost === 'object') normalized.cost = msg.cost;
    if (typeof msg.streamingMs === 'number') normalized.streamingMs = msg.streamingMs;
    if (typeof msg.modelId === 'string') normalized.modelId = msg.modelId;
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

module.exports = {
  VALID_ROLES,
  CHAT_ID_RE,
  assertChatId,
  messagesFilePath,
  listMessages,
  getMessage,
  appendMessage,
  replaceMessages,
  clearMessages
};
