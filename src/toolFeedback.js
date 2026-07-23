'use strict';

// Model-facing tool feedback compaction.
//
// Tool results have two consumers with different needs:
//   - the chat UI / transcript needs the complete structured result;
//   - the next model request needs a useful, bounded summary.
//
// This module only produces the second form. Callers keep the original result
// for SSE, persistence, traces, and UI rendering.

const DEFAULT_MAX_BYTES = 64 * 1024;
const MIN_MAX_BYTES = 4 * 1024;
const MAX_MAX_BYTES = 1024 * 1024;

function resolveMaxBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BYTES;
  return Math.max(MIN_MAX_BYTES, Math.min(MAX_MAX_BYTES, Math.floor(n)));
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value == null ? '' : value), 'utf8');
}

function utf8Prefix(buffer, bytes) {
  if (bytes <= 0) return '';
  let end = Math.min(buffer.length, bytes);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xC0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

function utf8Suffix(buffer, bytes) {
  if (bytes <= 0) return '';
  let start = Math.max(0, buffer.length - bytes);
  while (start < buffer.length && (buffer[start] & 0xC0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}

function truncateUtf8HeadTail(value, requestedMaxBytes) {
  const text = String(value == null ? '' : value);
  const maxBytes = resolveMaxBytes(requestedMaxBytes);
  const originalBytes = utf8Bytes(text);
  if (originalBytes <= maxBytes) return text;

  const raw = Buffer.from(text, 'utf8');
  let marker = '\n\n...[tool feedback truncated; original ' + originalBytes + ' bytes]...\n\n';
  let payloadBudget = Math.max(0, maxBytes - utf8Bytes(marker));
  let headBudget = Math.floor(payloadBudget * 0.75);
  let tailBudget = payloadBudget - headBudget;
  let head = utf8Prefix(raw, headBudget);
  let tail = utf8Suffix(raw, tailBudget);
  let output = head + marker + tail;

  // UTF-8 boundary cleanup and decimal metadata can shift the final size by a
  // few bytes. Tighten the payload until the complete string fits the cap.
  while (utf8Bytes(output) > maxBytes && (headBudget > 0 || tailBudget > 0)) {
    if (headBudget >= tailBudget && headBudget > 0) headBudget--;
    else if (tailBudget > 0) tailBudget--;
    head = utf8Prefix(raw, headBudget);
    tail = utf8Suffix(raw, tailBudget);
    output = head + marker + tail;
  }
  if (utf8Bytes(output) <= maxBytes) return output;
  marker = utf8Prefix(Buffer.from(marker, 'utf8'), maxBytes);
  return marker;
}

function safeJson(value, fallback) {
  try { return JSON.stringify(value); }
  catch { return fallback == null ? '{}' : String(fallback); }
}

function omitImagePayloads(value, seen) {
  if (!value || typeof value !== 'object') return value;
  const visited = seen || new WeakSet();
  if (visited.has(value)) return '[circular]';
  visited.add(value);
  if (Array.isArray(value)) return value.map((item) => omitImagePayloads(item, visited));

  const out = {};
  const isImage = value.type === 'image' || value.type === 'image_url';
  for (const [key, item] of Object.entries(value)) {
    if (isImage && (key === 'data' || key === 'base64' || key === 'dataUrl')) {
      out[key] = '[image payload omitted; attached separately]';
    } else if (isImage && key === 'url' && typeof item === 'string' && item.startsWith('data:image/')) {
      out[key] = '[image payload omitted; attached separately]';
    } else {
      out[key] = omitImagePayloads(item, visited);
    }
  }
  return out;
}

function subagentModelResult(result, content) {
  let source = result;
  if (!source || typeof source !== 'object') {
    try { source = JSON.parse(typeof content === 'string' ? content : ''); }
    catch { source = null; }
  }
  if (!source || typeof source !== 'object') return null;
  const out = { ok: source.ok !== false, text: typeof source.text === 'string' ? source.text : '' };
  if (source.error) {
    out.ok = false;
    out.error = {
      code: source.error.code || 'ESUBAGENT',
      message: source.error.message || String(source.error)
    };
  }
  return out;
}

function compactToolFeedback(options) {
  const opts = options || {};
  const name = String(opts.name || 'tool');
  let content = typeof opts.content === 'string' ? opts.content : safeJson(opts.content, '');

  if (name === 'subagent') {
    const compact = subagentModelResult(opts.result, content);
    if (compact) content = safeJson(compact, content);
  } else if (opts.result && typeof opts.result === 'object') {
    // Images are already attached to the following vision message by ai.js.
    // Avoid paying again for their base64 representation in role=tool text.
    const sanitized = omitImagePayloads(opts.result);
    if (safeJson(sanitized, '').includes('[image payload omitted; attached separately]')) {
      content = safeJson(sanitized, content);
    }
  }

  return truncateUtf8HeadTail(content, opts.maxBytes);
}

module.exports = {
  compactToolFeedback,
  truncateUtf8HeadTail,
  resolveMaxBytes,
  DEFAULT_MAX_BYTES,
  MIN_MAX_BYTES,
  MAX_MAX_BYTES
};
