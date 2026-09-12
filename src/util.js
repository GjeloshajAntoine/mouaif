'use strict';

// Leaf utility helpers shared across the server. This module deliberately
// requires nothing else so any domain module can pull from it without
// creating a require cycle. Helpers that used to be copy-pasted into
// several files (err, joinUrl, the first-*string finders) live here so
// there is exactly one definition.

// err(code, message, extra) — a typed Error with a machine-readable
// `code`. `extra`, when given, is copied onto the error (path, size,
// maxBytes, ...). Shared by mcp.js, tags.js, files.js and the
// ai-endpoints error helpers, all of which previously had an identical
// private copy.
function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// joinUrl(base, path) — concatenate a base URL and a relative/absolute
// path without doubling or dropping the single separating slash.
// Previously duplicated in ai-endpoints.js and ai-stream.js.
function joinUrl(base, path) {
  if (!base) return path;
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1);
  if (!base.endsWith('/') && !path.startsWith('/')) return base + '/' + path;
  return base + path;
}

// firstStringField(obj, names) — return the first present string value
// under one of `names`, else ''. Used by the streaming parsers to pick
// a reasoning/thinking field out of a provider delta whose key varies
// (reasoning, reasoning_content, thinking, ...). Semantically distinct
// from firstStringValue below (this one checks named keys, in order).
function firstStringField(obj, names) {
  if (!obj || typeof obj !== 'object') return '';
  for (const name of names) {
    if (typeof obj[name] === 'string') return obj[name];
  }
  return '';
}

// firstStringValue(value) — return the first string found among an
// object's own values, else ''. Used to derive a human-readable
// summary from a tool-call arguments object whose exact shape is not
// known ahead of time.
function firstStringValue(value) {
  if (!value || typeof value !== 'object') return '';
  for (const item of Object.values(value)) if (typeof item === 'string') return item;
  return '';
}

// qs(q, name) — read a query-string value without the longhand
// `typeof q.x === 'string' ? q.x : ''` that was repeated ~40 times
// across the server handlers. Mirrors readJsonBody's string-only
// coercion: a non-string query value (e.g. ?a=1&a=2 arriving as an
// array) safely becomes ''.
function qs(q, name) {
  return (q && typeof q[name] === 'string') ? q[name] : '';
}

// safeDecode(value) — decodeURIComponent that never throws. Every REST
// route that takes an id out of the path decodes the raw segment before
// handing it to a domain module; a malformed escape (`/api/chats/%zz`,
// `/api/projects/%zz/tags`, ...) used to raise a URIError from inside an
// async handler, which the HTTP dispatcher cannot catch: it surfaced as
// an unhandled rejection and, under Node's default
// `--unhandled-rejections=throw`, exited the process. Returning the raw
// segment on failure keeps the request a normal 400/404. Callers echo
// the value back through sendJSON, so nothing is interpreted as a path.
function safeDecode(value) {
  if (typeof value !== 'string') return '';
  try { return decodeURIComponent(value); } catch { return value; }
}
// projectModelRecord(record) — the only fields a project's `.mouaif.json`
// model entry may contribute to a request. Project models are identity and
// selection metadata only (decision §3): transport and credentials always
// come from the app-level provider connection. The project file is
// committed with the project, so a `baseUrl`, `apiKey`, `auth`, `headers`
// or `token` written there must never reach a request builder — it would
// point a global credential at an attacker-controlled endpoint.
//
// Allow-list, not deny-list: a field added later is ignored until it is
// listed here, instead of silently flowing through.
const PROJECT_MODEL_FIELDS = [
  'id', 'provider', 'label', 'contextWindow', 'pricing',
  'thinking', 'thinkingLevel', 'maxOutputTokens', 'maxTokens',
  // Dictation. A transcription model carries its own descriptor — the request
  // family, an optional non-conventional endpoint path, a language hint, a
  // prompt, or the plain `true` that marks it as a dictation choice. Without
  // it in this allow-list the field would be stripped before the request
  // builder ever sees it, and every model would fall back to the inferred
  // family.
  'transcription',
  // The request family the dictation catalog classified a live row under
  // (`openai-audio` for a model that can hear but has no
  // /audio/transcriptions entry). It rides the same path as `transcription`
  // and is honoured by transcribe.kindForModel, so the picker's "Sends as"
  // read-out is what the request does.
  'kind'
];

function projectModelRecord(record) {
  const out = {};
  if (!record || typeof record !== 'object') return out;
  for (const key of PROJECT_MODEL_FIELDS) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

// errCodeToHttpStatus(code, def) — one source of truth for mapping the
// typed error codes the domain modules throw (files, tags, mcp, the
// project/file/tags/prompt/agent handlers) to HTTP status codes. The
// project and file handlers previously each hand-enumerated overlapping
// subsets of this map in their own <x>ErrorStatus switch; prompt/agents
// shared a smaller 422/400/500 trio. `def` is the fallback (projects/add
// default 400, the model-facing ones default 500).
const HTTP_STATUS_BY_CODE = {
  EBADPATH: 400,
  EBADINPUT: 400,
  EOUTSIDE_PROJECT: 403,
  EOUTSIDE_HOME: 403,
  ENOENT: 404,
  ENOTDIR: 400,
  ENOTFILE: 400,
  EISDIR: 400,
  EACCES: 403,
  EEXIST: 409,
  EBINARY: 415,
  ENOTIMAGE: 415,
  ETOOLARGE: 413,
  EREAD: 500,
  MOUAIF_PROJECT_PARSE_ERROR: 422
};
function errCodeToHttpStatus(code, def) {
  return HTTP_STATUS_BY_CODE[code] || (def === undefined ? 500 : def);
}

module.exports = {
err,
joinUrl,
qs,
safeDecode,
projectModelRecord,
PROJECT_MODEL_FIELDS,
firstStringField,
firstStringValue,
errCodeToHttpStatus
};