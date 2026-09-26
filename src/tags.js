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
const hideFileContent = require('./hideFileContent.js');

// ---- Constants ----------------------------------------------------------

// Default per-file soft cap. Files larger than this are not auto-injected
// unless the user pins a smaller excerpt. Overridable via app.fileTagMaxBytes.
const DEFAULT_MAX_BYTES = 256 * 1024;

// Text-friendly extension allowlist (docs/decisions.md §15). Anything
// outside this list is reported by the scan as `binary: true` and cannot
// be tagged through the UI.
const DEFAULT_EXTS = [
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.json5', '.md',
  '.txt', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h',
  '.cpp', '.hpp', '.css', '.scss', '.less', '.html', '.vue', '.svelte',
  '.astro', '.yml', '.yaml', '.toml', '.sh', '.sql', '.graphql', '.gql',
  '.proto', '.ini', '.conf', '.cfg', '.env', '.lock', '.map', '.log',
  '.lua', '.pl', '.pm', '.r', '.jl', '.dart', '.zig', '.ex', '.exs',
  '.erl', '.hrl', '.fs', '.fsx', '.ml', '.clj', '.cljs', '.scala',
  '.groovy', '.gradle', '.tf', '.hcl', '.pug', '.jade', '.ejs', '.hbs',
  '.mustache', '.tpl', '.gitignore', '.gitattributes', '.editorconfig',
  '.eslintrc', '.prettierrc', '.babelrc', '.npmrc', '.nvmrc', '.yarnrc',
  '.dockerignore', '.gitmodules', '.htaccess', '.dockerfile', '.makefile'
];

const DEFAULT_EXT_SET = new Set(DEFAULT_EXTS);

// Directories the scan never descends into. `.mouaif` holds the tag map
// itself (and traces) — scanning it would just show `.mouaif.json`.
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
    // A bare key with no value (e.g. a hand-edited `"src/a.js": true`) is
    // not a meaningful entry — an empty tags list with includeInChat=true
    // would silently tag nothing while telling the UI the file is tagged.
    return { tags: [], excerpt: null, includeInChat: false };
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

// True when a file name is on the text allowlist. The check is against the
// extension (`app.vue` -> `.vue`, `my.config.js` -> `.js`), never the whole
// name, so a dot inside the base name never hides a file. Extensionless
// names match when allowlisted as `.<name>` (`Makefile`), and leading-dot
// names keep the dot in the key (`.env`, `.gitignore`, `.dockerignore`).
function isTextName(name, allow) {
  const set = allow || DEFAULT_EXT_SET;
  const ext = path.extname(name).toLowerCase();
  return set.has(ext)
    || (ext === '' && set.has('.' + name.toLowerCase()))
    || (ext === '' && /^\.[A-Za-z0-9_-]+$/.test(name) && set.has(name.toLowerCase()));
}

// One-pass directory walk. Returns text-ish files with size + ext and a
// `binary` flag for out-of-allowlist extensions. Skips heavy build dirs
// and nested tooling dirs (node_modules, .git, dist, build, .next, .cache,
// .mouaif). Root-level dotfiles and dot-dirs (.env, .github) are included —
// they are config the user tags. Bounded by `limit` (default 5000) so a
// huge project does not hang the request.
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
      // Hidden entries at the root (`.github`, `.env`, `.config`) are
      // usually config the user wants to tag, so they are NOT skipped
      // here. Nested hidden dirs are almost always tooling cache
      // (`.cache`, `.vite`); hidden files nested deeper are editor/
      // tool noise. The one exception: the tag map itself,
      // `.mouaif.json`, is skipped outright.
      const isHidden = dirent.name.startsWith('.');
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        // Nested hidden dirs (deeper than the project root) are almost
        // always tooling cache (`.cache`, `.vite`); the root-level ones
        // (`.github`, `.config`) are config the user tags.
        if (isHidden && dir !== rootResolved) continue;
        if (SKIP_DIRS.has(dirent.name)) continue;
        stack.push(full);
        continue;
      }
      if (!dirent.isFile()) continue;
      // The tag map itself must never appear as a taggable file.
      if (dirent.name === '.mouaif.json') continue;
      // Hidden files nested deeper than the root are tooling noise.
      if (isHidden && dir !== rootResolved) continue;
      const ext = path.extname(dirent.name).toLowerCase();
      let size = 0;
      try { size = fs.statSync(full).size; } catch { continue; }
      // Binary filter. The allowlist check is against the extension
      // (`app.vue` has ext `.vue`, `my.config.js` ext `.js`) — not the
      // whole name, so a dot inside the base name never hides a file.
      // A file is text when:
      //   - its extension is on the allowlist, OR
      //   - it has no extension and its name is either extensionless-but-
      //    -allowlisted (`Makefile`) or a leading-dot file whose suffix
      //     is allowlisted (`.env` -> `.env`, `.gitignore` -> `.gitignore`).
      //     Leading-dot names keep the dot in the extension key so the
      //     same allowlist covers `Dockerfile` and `.dockerignore`.
      const isText = isTextName(dirent.name, allow);
      out.push({
        path: path.relative(rootResolved, full).split(path.sep).join('/'),
        size,
        ext,
        binary: !isText
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
    // Same per-project redaction read_file applies, so lines the user
    // hid in Settings → Hide file content never ride in via a tag or an
    // @-mention either. startLine keeps excerpt line numbers aligned.
    hideFileContent.redactText(
      projectDir, relPath, readExcerpt(body, entry.excerpt),
      entry.excerpt ? Math.max(1, entry.excerpt.start) : 1
    ).text;

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
  const byPath = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
  const paths = Object.keys(map).sort(byPath);
  for (const rel of paths) {
    const entry = map[rel];
    const referenced = forceUserPaths.has(rel);
    if (!entry.includeInChat && !referenced) continue;
    const msg = buildInjectedMessage(projectDir, rel, entry, { maxBytes, forceUserPaths });
    if (msg) out.push(msg);
    else if (referenced) out.push(skippedReferenceMessage(projectDir, rel, entry, maxBytes));
  }
  // @-references to files that carry no tag entry. The composer popup
  // offers every scanned project file, so an explicit mention must attach
  // the file even when it was never tagged. Only text files on the scan
  // allowlist are attached; anything else is skipped silently, exactly as
  // parseReferences drops unresolvable tokens.
  const untagged = Array.from(forceUserPaths)
    .filter(rel => !Object.prototype.hasOwnProperty.call(map, rel))
    .sort(byPath);
  for (const rel of untagged) {
    if (!isTextName(path.posix.basename(rel))) continue;
    const entry = { tags: [], excerpt: null, includeInChat: false };
    const msg = buildInjectedMessage(projectDir, rel, entry, { maxBytes, forceUserPaths });
    if (msg) out.push(msg);
    else {
      const note = skippedReferenceMessage(projectDir, rel, entry, maxBytes);
      if (note) out.push(note);
    }
  }
  return out.filter(Boolean);
}

// An explicit @-reference the loader could not attach because the file is
// over the size cap. Returning a short note (instead of dropping it) tells
// the model the file exists and is large, so it can read it with a tool
// rather than guess. Missing, non-file, or escaping paths return null.
function skippedReferenceMessage(projectDir, relPath, entry, maxBytes) {
  let stat;
  try { stat = fs.statSync(toAbsInside(projectDir, relPath)); }
  catch { return null; }
  if (!stat.isFile() || entry.excerpt || stat.size <= maxBytes) return null;
  return {
    role: 'user',
    relPath,
    skipped: 'size',
    content:
      '# File: ' + relPath + '\n' +
      '# Not attached: ' + stat.size + ' bytes exceeds the ' + maxBytes + '-byte mention limit.\n' +
      'Read the parts you need with a file tool.'
  };
}

// Parse @<relPath> tokens out of a composer message. Returns the list of
// referenced relative paths (POSIX-normalized where possible; unparseable
// tokens are dropped). Used to promote a tagged file to a `user` message.
//
// Matching is relaxed on purpose: an exact `@src/api/users.js` works, and
// so does a bare basename `@users.js` when it uniquely identifies one
// file in the project. The basename is resolved against the tagged map
// (which is all the composer needs — an `@` mention is about files the
// user already tagged) and, as a fallback, the on-disk scan. Ambiguous
// basenames are resolved by the shortest path — the user attaches the
// file they can type — and dropped only when nothing at all matches.
function parseReferences(projectDir, text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  // @ followed by a path-ish token (no whitespace). Stops at whitespace.
  const re = /(?:^|\s)@([^\s]+)/g;
  let bareBases = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    // A slash means the user typed a path (`@src/api/users.js`) — resolve
    // it exactly. A bare token (`@users.js`) is a basename hint; leave it
    // for the resolution pass below so `@a.js` resolves to src/a.js
    // instead of being rejected as an ambiguous literal path.
    if (raw.indexOf('/') === -1) { bareBases.push(raw); continue; }
    try { out.push(toRelPath(projectDir, raw)); }
    catch { /* try basename resolution */ }
  }
  // Short-circuit: if there are no @-tokens at all (the common case), do
  // not touch the disk — parseReferences runs on every chat send.
  if (!out.length && !bareBases.length) return [];
  // Second pass: bare basename references. `@users.js` resolves the file
  // `src/api/users.js` when that is unambiguous.
  const byBase = new Map(); // basename -> [relPath]
  const tagged = (() => { try { return getTags(projectDir); } catch { return {}; } })();
  // Union of the on-disk scan and the tagged map. The scan is the primary
  // source (a mention can target any file in the project, tagged or not);
  // the tagged map is merged in so a stale/missing tagged path still
  // resolves even though the scan can no longer see it. scanFiles returns
  // objects ({path,size,ext,binary}); map them to their path strings here
  // so the byBase loop below sees the relPaths it expects.
  const candidates = []
    .concat((bareBases.length ? scanFiles(projectDir, null, 5000) : []).map(f => f.path))
    .concat(Object.keys(tagged))
    .filter(Boolean);
  // Only resolve bare basenames that were actually mentioned; scanning
  // is avoidable when every mention was already an exact path.
  for (const rel of candidates) {
    if (typeof rel !== 'string') continue;
    const name = String(rel).split('/').pop() || '';
    if (!name) continue;
    if (!byBase.has(name)) byBase.set(name, []);
    const arr = byBase.get(name);
    if (!arr.includes(rel)) arr.push(rel);
  }
  for (const raw of bareBases) {
    const base = String(raw).split('/').pop();
    if (out.some((p) => p === base)) continue; // exact path already resolved
    const hits = byBase.get(base) || [];
    if (hits.length === 1) {
      out.push(hits[0]);
    } else if (hits.length > 1) {
      // Shortest path wins for an ambiguous basename.
      hits.sort((a, b) => a.length - b.length);
      out.push(hits[0]);
    }
  }
  return Array.from(new Set(out));
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
