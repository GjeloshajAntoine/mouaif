'use strict';

// Per-chat trace writer — the per-chat NDJSON export described in
// docs/decisions.md section 5. Path: <projectDir>/.mouaif/traces/<chatId>.ndjson.
// Format: NDJSON, one event per line, append-only. No rotation, no
// auto-cleanup (decision section 5). If the chat's `trace` flag is
// false, the writer is a no-op. Each line is one event:
//
//   { ts: '2026-07-14T12:34:00.000Z', type: 'message' | 'done' | 'error' | ...,
//     ...payload }
//
// The filename identifies the chat, so the chatId is not duplicated on
// every line.

const fs = require('fs');
const path = require('path');
const { assertChatId } = require('./messages.js');

function traceFilePath(projectDir, chatId) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('projectDir must be a non-empty string');
  }
  assertChatId(chatId);
  return path.join(projectDir, '.mouaif', 'traces', chatId + '.ndjson');
}

function open(projectDir, chatId) {
  // Opens the trace file in append mode and returns a writer. Returns
  // null if traceDir cannot be created (the project may be on a
  // read-only filesystem; the writer becomes a no-op rather than
  // throwing on every event).
  const file = traceFilePath(projectDir, chatId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    return null;
  }
  try {
    return fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
  } catch (e) {
    return null;
  }
}

function write(stream, type, payload) {
  if (!stream) return; // no-op writer
  if (stream.destroyed || stream.writableEnded) return;
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), type }, payload || {})) + '\n';
  try { stream.write(line); } catch { /* swallow */ }
}

function close(stream) {
  if (!stream) return;
  try { stream.end(); } catch { /* swallow */ }
}

function eventForMessage(message) {
  const role = message && message.role;
  if (role === 'user') return { type: 'user_message', payload: { role, content: message.content, ts: message.ts } };
  if (role === 'assistant') return {
    type: 'assistant_message',
    payload: {
      role,
      content: message.content,
      ts: message.ts,
      usage: message.usage,
      cost: message.cost,
      streamingMs: message.streamingMs,
      modelId: message.modelId
    }
  };
  if (role === 'tool') return {
    type: message.phase === 'call' ? 'tool_call' : 'tool_result',
    payload: Object.assign({}, message, { type: undefined })
  };
  return { type: 'system', payload: { role: role || 'system', content: message && message.content, ts: message && message.ts } };
}

function exportMessages(projectDir, chatId, list) {
  const file = traceFilePath(projectDir, chatId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [];
  for (const message of list || []) {
    const event = eventForMessage(message);
    const payload = Object.assign({}, event.payload);
    delete payload.type;
    lines.push(JSON.stringify(Object.assign({ ts: payload.ts || new Date().toISOString(), type: event.type }, payload)));
  }
  fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  return file;
}

module.exports = {
  traceFilePath,
  open,
  write,
  close,
  eventForMessage,
  exportMessages
};
