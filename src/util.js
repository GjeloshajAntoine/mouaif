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

module.exports = {
  err,
  joinUrl,
  firstStringField,
  firstStringValue
};