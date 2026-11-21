'use strict';

// Read cache shared by the document stores.
//
// Tool authorization and hooks read project settings on every tool call, and
// every read used to re-query the DB or re-read the file and re-parse JSON.
// A store now keeps the last parsed object and hands out a copy while the
// document's version stamp is unchanged:
//
//   file  `<ino>:<size>:<mtimeNs>` — a hand edit changes mtime, and every
//         atomic write (ours or another process's) renames a new inode in
//   DB    `<handle generation>:<data_version>:<total_changes()>` —
//         data_version moves when ANOTHER connection commits; total_changes()
//         moves on every write made through this process's own connection,
//         whichever module made it (a direct SQL write in a migration or a
//         test included)
//
// Callers mutate what they read (`delete next[key]`), so every hit returns a
// fresh copy and the cached object is never handed out.

const fs = require('fs');
const contentDb = require('../db.js');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep copy of a JSON value. Faster than structuredClone for the small,
// plain documents stored here.
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }
  return value;
}

// ---- Files ---------------------------------------------------------------
//
// Filesystem timestamps are coarse (a kernel tick, a few ms), so two in-place
// writes of the same size can share a stamp. Like git's "racy" index entries,
// a file modified less than RACY_MS ago is not trusted on its stamp alone: it
// is re-read and compared with the cached text, which still saves the parse.

const RACY_MS = 2000;
const fileCache = new Map();

function statFile(filePath) {
  return fs.statSync(filePath, { bigint: true, throwIfNoEntry: false });
}

function fileStamp(filePath) {
  const st = statFile(filePath);
  return st ? st.ino + ':' + st.size + ':' + st.mtimeNs : null;
}

// readFile(filePath, parse, missing) — `parse(text)` turns the file into its
// value, `missing()` is what an absent file reads as. Neither an absent file
// nor a parse that throws is cached.
function readFile(filePath, parse, missing) {
  const st = statFile(filePath);
  if (!st) {
    fileCache.delete(filePath);
    return missing();
  }
  const stamp = st.ino + ':' + st.size + ':' + st.mtimeNs;
  const hit = fileCache.get(filePath);
  const racy = Date.now() - Number(st.mtimeMs) < RACY_MS;
  if (hit && hit.stamp === stamp && !racy) return clone(hit.value);
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fileCache.delete(filePath);
    return missing();
  }
  if (hit && hit.text === text) {
    hit.stamp = stamp;
    return clone(hit.value);
  }
  const value = parse(text);
  fileCache.set(filePath, { stamp, text, value: clone(value) });
  return value;
}

// Record what was just written (`text` is the exact file body), so the next
// read is a hit.
function wroteFile(filePath, value, text) {
  const stamp = fileStamp(filePath);
  if (stamp === null) fileCache.delete(filePath);
  else fileCache.set(filePath, { stamp, text, value: clone(value) });
}

// ---- DB rows -------------------------------------------------------------

const rowCache = new Map();
let stampStatement = null;
let stampGeneration = -1;

function dbStamp() {
  const d = contentDb.db();
  if (stampGeneration !== contentDb.generation()) {
    stampStatement = d.prepare("SELECT data_version || ':' || total_changes() FROM pragma_data_version").pluck();
    stampGeneration = contentDb.generation();
  }
  return stampGeneration + ':' + stampStatement.get();
}

// readRow(key, load) — `load()` returns the row's parsed entry
// (`{ exists, value }`). Cached until any write reaches the store.
function readRow(key, load) {
  // A transaction may see uncommitted writes or roll them back. Don't let
  // that snapshot populate the cache used by readers outside the transaction.
  if (contentDb.db().inTransaction) return load();
  const stamp = dbStamp();
  const hit = rowCache.get(key);
  if (hit && hit.stamp === stamp) return { exists: hit.exists, value: clone(hit.value) };
  const entry = load();
  // Use the stamp from before the read. Another connection might have
  // committed since load(), and a newer stamp would hide that update.
  rowCache.set(key, { stamp, exists: entry.exists, value: clone(entry.value) });
  return entry;
}

// peekRow(key, load) — like readRow, but returns the cached value itself for
// a read-only check (the storage-mode marker). Never hand it to a caller that
// could mutate it.
function peekRow(key, load) {
  if (contentDb.db().inTransaction) return load();
  const stamp = dbStamp();
  let hit = rowCache.get(key);
  if (!hit || hit.stamp !== stamp) {
    readRow(key, load);
    hit = rowCache.get(key);
  }
  return hit;
}

// Invalidate instead of stamping the writer's value: another connection
// may have committed by the time we can read a fresh stamp.
function wroteRow(key) {
  rowCache.delete(key);
}

function clear() {
  fileCache.clear();
  rowCache.clear();
}

module.exports = { clone, fileStamp, readFile, wroteFile, dbStamp, readRow, peekRow, wroteRow, clear };
