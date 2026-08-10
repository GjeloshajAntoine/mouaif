'use strict';

// File tagging — annotate project files and inject them into a chat.
//
// Implements docs/decisions.md §15 and docs/features/file-tagging.md.
// Tags live in `<projectDir>/.mouaif.json` under a top-level `tags` key so
// they can be committed with the project and edited by hand.
//
// Schema (inside project.tags):
//   {
//     "<relPath>": {
//       tags:          ['api', 'auth'],       // free-form chip list
//       excerpt:       { start, end } | null, // 1-indexed inclusive; null = whole file
//       includeInChat: true,                  // auto-inject on send (default true)
//       note?:         'exceeds fileTagMaxBytes' // set by the size-cap guard
//     },
//     ...
//   }
//
// Public surface:
//   getTags(projectDir)                        -> { "<relPath>": entry, ... }
//   setTags(projectDir, map)                   -> normalized map (persisted)
//   removeTag(projectDir, relPath)             -> boolean
//   scanFiles(projectDir, exts?)               -> [{ path, size, ext, binary }]
//   resolveForInjection(projectDir, opts?)     -> [{ role, content, relPath }]
//
// Path normalization: every relPath is stored POSIX-relative to the
// project root (`src/api/users.js`). The injection loader resolves with
// path.join and refuses anything that escapes the root (`..`, absolute,
// or a symlink pointing outside) with EOUTSIDE_PROJECT.

const fs = require('fs');
const path = require('path');
const { err } = require('./util.js');
const settings = require('./settings.js');

// ---- Constants ----------------------------------------------------------

// Default per-file soft cap. Files larger than this are not auto-injected
// unless the user pins a smaller excerpt. Overridable via app.fileTagMaxBytes.
const DEFAULT_MAX_BYTES = 256 * 1024;

// Text-friendly extension allowlist (docs/decisions.md §15). Anything
// outside this list is reported by the scan as `binary: true` and cannot
// be tagged through the UI.
const DEFAULT_EXTS = [
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.txt',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h',
  '.cpp', '.hpp', '.css', '.html', '.yml', '.yaml', '.toml', '.sh'
];

// Directories the scan never descends into.
const SKIP_DIRS = new Set(['node_modules', '.git', '.mouaif', 'dist', 'build', '.next', '.cache']);

// ---- Path safety --------------------------------------------------------

// err() is shared from src/util.js.

// Normalize any incoming path to a POSIX-relative path under projectDir.
// Throws EOUTSIDE_PROJECT if it escapes the root. Does NOT touch disk.
function toRelPath(projectDir, p) {
  if (typeof p !== 'string' || !p.trim()) {
    throw err('EBADINPUT', 'path is required');
  }
  const rootResolved = path.resolve(projectDir);
  // Accept both an already-relative path and an absolute path inside root.
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(rootResolved, p);
  const rel = path.relative(rootResolved, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw err('EOUTSIDE_PROJECT', 'Path escapes the project root', { path: p });
  }
  // Store POSIX-style so the file round-trips across OSes.
  return rel.split(path.sep).join('/');
}

// Resolve a stored relPath back to an absolute path, refusing escapes.
// Also checks that the realpath (following symlinks) stays inside root.
function toAbsInside(projectDir, relPath) {
  const rootResolved = path.resolve(projectDir);
  const abs = path.resolve(rootResolved, relPath);
  const rel = path.relative(rootResolved, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw err('EOUTSIDE_PROJECT', 'Path escapes the project root', { path: relPath });
  }
  // Symlink guard: if the file exists and its realpath leaves root, refuse.
  try {
    const real = fs.realpathSync(abs);
    const realRel = path.relative(fs.realpathSync(rootResolved), real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw err('EOUTSIDE_PROJECT', 'Symlink target escapes the project root', { path: relPath });
    }
  } catch (e) {
    if (e.code === 'EOUTSIDE_PROJECT') throw e;
    // ENOENT (stale path) is fine here — the caller handles missing files.
  }
  return abs;
}

// ---- Entry normalization ------------------------------------------------

function normalizeExcerpt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const start = Number(raw.start);
  const end = Number(raw.end);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 1 || end < 1 || end < start) return null;
  return { start, end };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    return { tags: [], excerpt: null, includeInChat: true };
  }
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim())
    : [];
  const entry = {
    tags,
    excerpt: normalizeExcerpt(raw.excerpt),
    includeInChat: raw.includeInChat !== false
  };
  if (typeof raw.note === 'string' && raw.note) entry.note = raw.note;
  return entry;
}

function normalizeMap(projectDir, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    let rel;
    try { rel = toRelPath(projectDir, key); }
    catch { continue; } // drop entries that escape the root
    out[rel] = normalizeEntry(raw[key]);
  }
  return out;
}

// ---- CRUD ---------------------------------------------------------------

function getTags(projectDir) {
  const project = settings.getProject(projectDir);
  return normalizeMap(projectDir, project && project.tags);
}

function setTags(projectDir, map) {
  const normalized = normalizeMap(projectDir, map);
  settings.setProject(projectDir, { tags: normalized });
  return normalized;
}

function removeTag(projectDir, relPathOrAbs) {
  const rel = toRelPath(projectDir, relPathOrAbs);
  const project = settings.getProject(projectDir);
  const current = normalizeMap(projectDir, project && project.tags);
  if (!Object.prototype.hasOwnProperty.call(current, rel)) return false;
  delete current[rel];
  settings.setProject(projectDir, { tags: current });
  return true;
}

// ---- Scan ---------------------------------------------------------------

// One-pass directory walk. Returns text-ish files with size + ext and a
// `binary` flag for out-of-allowlist extensions. Skips heavy build dirs
// and dotfiles. Bounded by `limit` (default 5000) so a huge project does
// not hang the request.
function scanFiles(projectDir, exts, limit) {
  const rootResolved = path.resolve(projectDir);
  const allow = new Set((Array.isArray(exts) && exts.length ? exts : DEFAULT_EXTS)
    .map(e => (e.startsWith('.') ? e : '.' + e).toLowerCase()));
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 5000;
  const out = [];
  const stack = [rootResolved];
  while (stack.length && out.length < cap) {
    const dir = stack.pop();
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const dirent of names) {
      if (dirent.name.startsWith('.')) continue;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue;
        stack.push(full);
        continue;
      }
      if (!dirent.isFile()) continue;
      const ext = path.extname(dirent.name).toLowerCase();
      let size = 0;
      try { size = fs.statSync(full).size; } catch { continue; }
      out.push({
        path: path.relative(rootResolved, full).split(path.sep).join('/'),
        size,
        ext,
        binary: !allow.has(ext)
      });
      if (out.length >= cap) break;
    }
  }
  out.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  return out;
}

// ---- Injection ----------------------------------------------------------

function readExcerpt(body, excerpt) {
  if (!excerpt) return body;
  const lines = body.split(/\r?\n/);
  // 1-indexed inclusive: [2,2] contains line 2.
  const start = Math.max(1, excerpt.start);
  const end = Math.min(lines.length, excerpt.end);
  return lines.slice(start - 1, end).join('\n');
}

function excerptHeader(excerpt) {
  if (!excerpt) return '';
  return '# Excerpt: ' + excerpt.start + '-' + excerpt.end + '\n';
}

// Build one synthetic message for a tagged file. Returns null when the
// file is missing, oversized (and not excerpted), or excluded. The role
// defaults to 'system'; explicit @-referenced files are promoted to
// 'user' by the caller passing forceUserPaths.
function buildInjectedMessage(projectDir, relPath, entry, opts) {
  const maxBytes = (opts && Number.isInteger(opts.maxBytes) && opts.maxBytes > 0)
    ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const forced = opts && opts.forceUserPaths instanceof Set && opts.forceUserPaths.has(relPath);

  let abs;
  try { abs = toAbsInside(projectDir, relPath); }
  catch { return null; } // escapes root — skip silently

  let stat;
  try { stat = fs.statSync(abs); }
  catch { return null; } // stale / missing — skip at injection time

  if (!stat.isFile()) return null;

  // Size cap: oversized files are skipped unless the user pinned an
  // excerpt (a smaller window bypasses the cap).
  if (!entry.excerpt && stat.size > maxBytes) return null;

  let body;
  try { body = fs.readFileSync(abs, 'utf8'); }
  catch { return null; }

  const content =
    '# File: ' + relPath + '\n' +
    '# Tags: ' + (entry.tags.length ? entry.tags.join(', ') : '(none)') + '\n' +
    excerptHeader(entry.excerpt) +
    '\n' +
    readExcerpt(body, entry.excerpt);

  return { role: forced ? 'user' : 'system', content, relPath };
}

// Resolve every tagged file that should be injected for a chat send.
// - includeInChat === true entries are injected as `system`.
// - Any relPath listed in opts.referencedPaths is injected as `user`
//   (the composer @-reference), regardless of includeInChat, so an
//   explicit mention always wins.
// Returns an array of { role, content, relPath } in stable path order.
function resolveForInjection(projectDir, opts) {
  const map = getTags(projectDir);
  let maxBytes = DEFAULT_MAX_BYTES;
  try {
    const app = settings.getApp();
    if (app && Number.isInteger(app.fileTagMaxBytes) && app.fileTagMaxBytes > 0) {
      maxBytes = app.fileTagMaxBytes;
    }
  } catch { /* keep default */ }

  const forceUserPaths = new Set();
  if (opts && Array.isArray(opts.referencedPaths)) {
    for (const p of opts.referencedPaths) {
      try { forceUserPaths.add(toRelPath(projectDir, p)); }
      catch { /* ignore bad @-reference */ }
    }
  }

  const out = [];
  const paths = Object.keys(map).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const rel of paths) {
    const entry = map[rel];
    const referenced = forceUserPaths.has(rel);
    if (!entry.includeInChat && !referenced) continue;
    const msg = buildInjectedMessage(projectDir, rel, entry, { maxBytes, forceUserPaths });
    if (msg) out.push(msg);
  }
  return out;
}

// Parse @<relPath> tokens out of a composer message. Returns the list of
// referenced relative paths (POSIX-normalized where possible; unparseable
// tokens are dropped). Used to promote a tagged file to a `user` message.
function parseReferences(projectDir, text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  // @ followed by a path-ish token (no whitespace). Stops at whitespace.
  const re = /(?:^|\s)@([^\s]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    try { out.push(toRelPath(projectDir, raw)); }
    catch { /* skip tokens that escape root or are not paths */ }
  }
  return out;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_EXTS,
  toRelPath,
  getTags,
  setTags,
  removeTag,
  scanFiles,
  resolveForInjection,
  parseReferences
};
