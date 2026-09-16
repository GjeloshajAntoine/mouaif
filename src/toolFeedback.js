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

// Tool output profile (per-project `toolOutput`). `size` picks how much of
// a result the model sees before the truncation marker; `structure` picks
// how the serialized body is laid out. Only defined values are honored —
// anything else falls back to the safe default (`average` / `full`).
const SIZE_MULTIPLIER = Object.freeze({
  'very-small': 0.25, // a quarter of the cap: head/tail only
  average: 1,         // the cap itself (default, 64 KiB)
  full: 4,            // four times the cap: bigger results pass through
  extensive: Infinity // never truncate
});
// `structure` values:
//   - `full`    — raw body (kept for back-compat); generic tools use it.
//   - `concise` — whitespace/JSON minification for generic tools.
//   - `json`    — file-tool results serialized as their structured JSON.
//   - `tree`    — file listings as an indented hierarchical tree (the
//                 default file-tool layout: every shared path prefix is
//                 printed once, files nested two spaces per depth level).
// The file-listing values only change how the native file tools render;
// for generic (shell / MCP) output they behave like `full`.
const STRUCTURES = Object.freeze(['full', 'concise', 'json', 'tree']);
const FILE_STRUCTURES = Object.freeze(['json', 'tree']);
const DEFAULT_SIZE = 'average';
const DEFAULT_STRUCTURE = 'tree';

function resolveToolOutput(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const size = Object.prototype.hasOwnProperty.call(SIZE_MULTIPLIER, o.size) ? o.size : DEFAULT_SIZE;
  const structure = STRUCTURES.includes(o.structure) ? o.structure : DEFAULT_STRUCTURE;
  return { size, structure };
}

// Effective byte cap for a size profile, against the configured base cap.
// `null` / `undefined` base uses the module default. `Infinity` (extensive)
// returns Infinity so the truncator passes the result through unchanged.
function effectiveMaxForSize(size, baseMaxBytes) {
  const mult = SIZE_MULTIPLIER[size] === undefined ? 1 : SIZE_MULTIPLIER[size];
  if (mult === Infinity) return Infinity;
  const base = resolveMaxBytes(baseMaxBytes);
  return Math.max(MIN_MAX_BYTES, Math.floor(base * mult));
}

function resolveMaxBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BYTES;
  return Math.max(MIN_MAX_BYTES, Math.min(MAX_MAX_BYTES, Math.floor(n)));
}

// Compact a JSON-ish string to its minimal single-line form, so the model
// pays once for keys/whitespace instead of re-reading an indented blob.
// Plain (non-JSON) text is returned with runs of blank lines collapsed.
function conciseLayout(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return s;
  try {
    const parsed = JSON.parse(s);
    return JSON.stringify(parsed);
  } catch { /* not JSON — fall through */ }
  return s.replace(/\n[ \t]*\n+/g, '\n').replace(/^[ \t]+/gm, '').replace(/\s+$/gm, '');
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
  // Explicit `Infinity` means "no cap" (the `extensive` output size).
  // resolveMaxBytes would clamp it to MAX_MAX_BYTES, losing the intent.
  if (requestedMaxBytes === Infinity) return text;
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
    } else if (key === 'thumbnail' && typeof item === 'string' && item.startsWith('data:image/')) {
      // webpreview keeps its screenshot on `result.thumbnail` for the UI rather
      // than in a generic image block. Historical tool feedback must strip it
      // too, otherwise the next model turn receives the user-only preview.
      out[key] = '[user preview image omitted]';
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
  } else if (name === 'image_gen') {
    // The picture bytes are attached to the following vision message (see
    // toolResultImageParts in src/ai-stream.js), so the tool text must
    // carry what the model *acts on*: which files were written, their MIME
    // type and size, and the model that ran. Serializing the full result
    // would pay for the base64 once per turn even though the payload is
    // replaced by a marker.
    const r = (opts.result && typeof opts.result === 'object') ? opts.result : null;
    if (r) {
      const compact = {
        ok: r.ok !== false,
        model: r.model || null,
        images: Array.isArray(r.images)
          ? r.images.map((i) => ({ relPath: i.relPath, mimeType: i.mimeType, bytes: i.bytes }))
          : [],
        note: 'The generated image is attached to this tool result as an image part.'
      };
      if (r.error) compact.error = { code: (r.error.code || 'EIMAGE'), message: r.error.message || String(r.error) };
      content = safeJson(compact, content);
    }
  } else if (opts.result && typeof opts.result === 'object') {
    // Images are already attached to the following vision message by ai.js.
    // Avoid paying again for their base64 representation in role=tool text.
    const sanitized = omitImagePayloads(opts.result);
    const sanitizedJson = safeJson(sanitized, '');
    if (sanitizedJson.includes('[image payload omitted; attached separately]')
      || sanitizedJson.includes('[user preview image omitted]')) {
      content = sanitizedJson;
    }
  }

  // Apply the per-project tool output profile: `structure` before `size`,
  // so a concise layout is compacted first and then bounded by the size
  // budget. Defaults keep legacy behavior (full body, `average` cap).
  const profile = resolveToolOutput(opts.toolOutput);
  const layout = profile.structure === 'concise' ? conciseLayout(content) : content;
  const maxBytes = effectiveMaxForSize(profile.size, opts.maxBytes);
  return truncateUtf8HeadTail(layout, maxBytes);
}

module.exports = {
  compactToolFeedback,
  truncateUtf8HeadTail,
  resolveMaxBytes,
  effectiveMaxForSize,
  resolveToolOutput,
  FILE_STRUCTURES,
  DEFAULT_MAX_BYTES,
  MIN_MAX_BYTES,
  MAX_MAX_BYTES
};
