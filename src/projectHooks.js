'use strict';

// Project hooks and their trust (docs/features/hooks.md, spec phase 4).
//
// A project can define hooks in its settings (`hooks: [...]` in .mouaif.json,
// or the DB-backed settings row), with the same entry shape as app hooks.
// A cloned repository must not run code on the first prompt, so project
// hooks are INERT until the user trusts their content hash:
//
//   hash = sha256 over the hooks list (canonical JSON, inline scripts and
//          modules included) + every project file a command or inline script
//          names by relative path (`./scripts/check.sh`, `node tools/hook.js`,
//          `cd scripts && ./run.sh`).
//
// A change to the list or one of those files, or one of them appearing or
// going away, gives a new hash, and the hooks are inert again until reviewed.
// Only paths written out literally can be followed: `$DIR/x.sh`, or a file a
// reviewed script itself calls, is outside the hash. Project hooks run from
// the project folder (src/hooks.js), which is what these paths resolve against.
// The trust record lives in the app database (`hook_trust`), never in the
// repository.
//
// Extensions (phase 5) reuse this store with their own key.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Past this many paths to stat, a project's hooks are re-read on every lookup.
const MAX_WATCH = 200;
const MAX_CD = 8;
const HOOKS_KEY = 'hooks';
// A bare word after one of these is a file it runs (`sh check`).
const RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'node', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl', 'php', 'source', '.', 'exec']);

const CREATE = `
  CREATE TABLE IF NOT EXISTS hook_trust (
    project_dir TEXT NOT NULL,
    key         TEXT NOT NULL,
    hash        TEXT NOT NULL,
    trusted_at  INTEGER NOT NULL,
    PRIMARY KEY (project_dir, key)
  )
`;

let db = null;
function store() {
  if (db) return db;
  const d = require('./settings.js').getDb();
  d.exec(CREATE);
  db = d;
  return d;
}

function hooksMod() { return require('./hooks.js'); }

// Stable JSON: object keys sorted, so a reformatted file keeps its hash.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function insideProject(rel) {
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// Every relative path a command line or script could be naming, whether or not
// it exists yet: words with a `/` or `.`, bare words after a runner, each also
// tried under the folders the text `cd`s into.
function candidatePaths(text) {
  const words = String(text || '').split(/[\s;&|()<>`'"=,]+/).filter(Boolean);
  const usable = (word) => !path.isAbsolute(word) && !word.startsWith('-') && !word.includes('$') && !word.includes('://');
  const dirs = [''];
  words.forEach((word, i) => {
    if (words[i - 1] === 'cd' && usable(word) && dirs.length <= MAX_CD && !dirs.includes(word)) dirs.push(word);
  });
  const out = new Set();
  words.forEach((word, i) => {
    if (!usable(word) || !(/[/.]/.test(word) || RUNNERS.has(words[i - 1]))) return;
    for (const dir of dirs) out.add(path.join(dir, word));
  });
  return [...out];
}

// The project files a command line or script names: any candidate that is an
// existing regular file inside the project. Absolute paths and paths that
// leave the project are outside the hash (and outside what a clone can ship).
function referencedFiles(projectDir, command) {
  const out = [];
  let root;
  try { root = fs.realpathSync(projectDir); } catch { return out; }
  for (const word of candidatePaths(command)) {
    const abs = path.resolve(root, word);
    // Most candidates do not exist: a stat that does not throw keeps them cheap.
    let stat;
    try { stat = fs.statSync(abs, { throwIfNoEntry: false }); } catch { continue; }
    if (!stat || !stat.isFile()) continue;
    let rel;
    try { rel = path.relative(root, fs.realpathSync(abs)); } catch { continue; }
    if (insideProject(rel) && !out.includes(rel)) out.push(rel);
  }
  return out;
}

// hookFiles(projectDir, hook) -> the project files this hook's command or
// inline script names.
function hookFiles(projectDir, hook) {
  const handler = hook && hook.handler;
  if (!handler || handler.kind !== 'command') return [];
  return referencedFiles(projectDir, handler.command || handler.script);
}

// Hash a whole file without holding it in memory. Throws when it can't be opened.
function hashFile(h, abs, rel) {
  const fd = fs.openSync(abs, 'r');
  try {
    h.update('file ' + rel + '\n');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (let n = fs.readSync(fd, chunk, 0, chunk.length); n > 0; n = fs.readSync(fd, chunk, 0, chunk.length)) {
      h.update(chunk.subarray(0, n));
      bytes += n;
    }
    h.update('\n');
    return bytes;
  } finally { fs.closeSync(fd); }
}

// read(projectDir) -> { hooks, errors, files: [{ path, bytes, missing? }], hash }
// `hooks` are the valid entries (normalized), `errors` the invalid ones. A
// non-enumerable `watch` lists every path whose appearance would change the
// hash, or is null when there are too many to stat on each lookup.
function read(projectDir) {
  let raw = [];
  try {
    const project = require('./settings.js').getProject(projectDir);
    raw = Array.isArray(project && project.hooks) ? project.hooks : [];
  } catch { raw = []; }
  const hooks = [];
  const errors = [];
  const seen = new Set();
  raw.forEach((entry, i) => {
    try {
      const hook = hooksMod().normalizeHook(entry, i);
      if (seen.has(hook.id)) throw new Error('hook id "' + hook.id + '" is used twice');
      seen.add(hook.id);
      hooks.push(hook);
    } catch (e) { errors.push({ index: i, error: e.message }); }
  });
  const files = [];
  const h = crypto.createHash('sha256');
  h.update('hooks\n' + canonical(raw) + '\n');
  const paths = [];
  const watch = new Set();
  for (const hook of hooks) {
    if (hook.handler.kind !== 'command') continue;
    for (const p of hookFiles(projectDir, hook)) if (!paths.includes(p)) paths.push(p);
    for (const p of candidatePaths(hook.handler.command || hook.handler.script)) watch.add(p);
  }
  for (const rel of paths) {
    try { files.push({ path: rel, bytes: hashFile(h, path.join(projectDir, rel), rel) }); }
    catch { files.push({ path: rel, missing: true }); h.update('missing ' + rel + '\n'); }
  }
  const value = { hooks, errors, files, hash: raw.length ? h.digest('hex') : '' };
  Object.defineProperty(value, 'watch', { value: watch.size > MAX_WATCH ? null : [...watch], enumerable: false });
  return value;
}

function statPart(abs) {
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  return stat ? stat.ino + ':' + stat.size + ':' + stat.mtimeMs : '-';
}

// Cache by the settings and by what the hash reads: the files it covers and
// every path that would join it by appearing. So a tool call does not re-hash
// the project each time, and a script that shows up later is still noticed.
const cache = new Map();
function fingerprint(projectDir, value) {
  const settings = require('./settings.js');
  const parts = [];
  // The hooks as the settings document holds them now, in either storage
  // mode. Reading the document is a cache hit unless it changed (the store
  // checks its file stamp or DB change counter, src/content/stores/cache.js).
  try { parts.push(JSON.stringify(settings.getProject(projectDir).hooks || null)); } catch { parts.push('?'); }
  for (const rel of [...value.files.map((f) => f.path), ...value.watch]) {
    try { parts.push(rel + ':' + statPart(path.join(projectDir, rel))); } catch { parts.push(rel + ':?'); }
  }
  return parts.join('|');
}
function readCached(projectDir) {
  const hit = cache.get(projectDir);
  if (hit && hit.fp === fingerprint(projectDir, hit.value)) return hit.value;
  const value = read(projectDir);
  if (value.watch) cache.set(projectDir, { fp: fingerprint(projectDir, value), value });
  return value;
}

// Trust rows are keyed by the resolved project path, like project settings.
function dirKey(projectDir) { return path.resolve(String(projectDir || '')); }

// Prepared once: runHooks reads this twice per tool call.
let trustStatement = null;
function trustedHash(projectDir, key = HOOKS_KEY) {
  try {
    if (!trustStatement) trustStatement = store().prepare('SELECT hash FROM hook_trust WHERE project_dir = ? AND key = ?');
    const row = trustStatement.get(dirKey(projectDir), key);
    return row ? row.hash : '';
  } catch { return ''; }
}

function setTrust(projectDir, hash, key = HOOKS_KEY) {
  store().prepare(`INSERT INTO hook_trust (project_dir, key, hash, trusted_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(project_dir, key) DO UPDATE SET hash = excluded.hash, trusted_at = excluded.trusted_at`)
    .run(dirKey(projectDir), key, hash, Date.now());
}

function revoke(projectDir, key = HOOKS_KEY) {
  return store().prepare('DELETE FROM hook_trust WHERE project_dir = ? AND key = ?').run(dirKey(projectDir), key).changes > 0;
}

// status(projectDir) -> { hooks, errors, files, hash, trusted, trustedHash, changed }
function status(projectDir) {
  const r = readCached(projectDir);
  const t = trustedHash(projectDir);
  return Object.assign({}, r, { trusted: !!r.hash && t === r.hash, trustedHash: t || null, changed: !!t && !!r.hash && t !== r.hash });
}

// active(projectDir) -> [hook] — enabled project hooks, or [] when untrusted.
function active(projectDir) {
  const s = status(projectDir);
  return s.trusted ? s.hooks.filter((h) => h.enabled) : [];
}

// trust(projectDir, hash) — only the hash the user reviewed: a file that
// changed between the review and the tap is refused (409).
function trust(projectDir, hash) {
  cache.delete(projectDir);
  const s = status(projectDir);
  if (!s.hash) throw new (hooksMod().HookError)('this project defines no hooks', 404);
  if (hash !== s.hash) throw new (hooksMod().HookError)('the project hooks changed since you reviewed them; review them again', 409);
  setTrust(projectDir, s.hash);
  return status(projectDir);
}

// append(projectDir, hook) -> { hook, trusted } — add a hook to the project's
// settings (the model's hook_create with scope "project" after its card, or
// a chat hook promoted to the project). The new list is trusted only when the
// list before it was trusted (or empty): an unreviewed project hook must not
// ride along with one the user just approved.
function append(projectDir, hook) {
  const settings = require('./settings.js');
  cache.delete(projectDir);
  const before = status(projectDir);
  const wasTrusted = !before.hash || before.trusted;
  const current = Array.isArray(settings.getProject(projectDir).hooks) ? settings.getProject(projectDir).hooks : [];
  const ids = new Set(current.map((h) => h && h.id));
  const entry = hooksMod().normalizeHook(hook);
  let id = entry.id;
  for (let i = 2; ids.has(id); i++) id = entry.id.slice(0, 34) + '-' + i;
  entry.id = id;
  settings.setProject(projectDir, { hooks: current.concat(entry) });
  cache.delete(projectDir);
  const after = status(projectDir);
  if (wasTrusted && after.hash && !after.errors.length) setTrust(projectDir, after.hash);
  return { hook: entry, trusted: wasTrusted };
}

module.exports = { HOOKS_KEY, canonical, referencedFiles, hookFiles, read, status, active, trust, revoke, append, trustedHash, setTrust,
  _clearCache: () => cache.clear() };
