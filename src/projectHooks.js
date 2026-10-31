'use strict';

// Project hooks and their trust (docs/features/hooks.md, spec phase 4).
//
// A project can define hooks in its settings (`hooks: [...]` in .mouaif.json,
// or the DB-backed settings row), with the same entry shape as app hooks.
// A cloned repository must not run code on the first prompt, so project
// hooks are INERT until the user trusts their content hash:
//
//   hash = sha256 over the hooks list (canonical JSON, inline scripts and
//          modules included) + every project file a command hook runs by
//          relative path (`./scripts/check.sh`, `node tools/hook.js`).
//
// Any change — a `git pull` that edits a hook or a script it calls — gives a
// new hash, and the hooks are inert again until reviewed. The trust record
// lives in the app database (`hook_trust`), never in the repository.
//
// Extensions (phase 5) reuse this store with their own key.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE = 1024 * 1024;
const MAX_FILES = 20;
const HOOKS_KEY = 'hooks';

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

// The project files a command line runs by relative path: any word that
// names an existing regular file inside the project (`./x.sh`, `scripts/y`,
// `node tools/z.js`). Absolute paths and paths that leave the project are
// outside the hash (and outside what a clone can ship).
function referencedFiles(projectDir, command) {
  const out = [];
  let root;
  try { root = fs.realpathSync(projectDir); } catch { return out; }
  for (const raw of String(command || '').split(/[\s;&|()<>]+/)) {
    const word = raw.replace(/^['"]|['"]$/g, '');
    if (!word || path.isAbsolute(word) || word.startsWith('-') || word.includes('$')) continue;
    if (!/[/.]/.test(word)) continue;
    let real;
    try { real = fs.realpathSync(path.resolve(root, word)); } catch { continue; }
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    try { if (!fs.statSync(real).isFile()) continue; } catch { continue; }
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

// read(projectDir) -> { hooks, errors, files: [{ path, bytes, missing? }], hash }
// `hooks` are the valid entries (normalized), `errors` the invalid ones.
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
  for (const hook of hooks) {
    if (hook.handler.kind === 'command' && hook.handler.command) {
      for (const p of referencedFiles(projectDir, hook.handler.command)) if (!paths.includes(p)) paths.push(p);
    }
  }
  for (const rel of paths.slice(0, MAX_FILES)) {
    const abs = path.join(projectDir, rel);
    try {
      const buf = fs.readFileSync(abs);
      const body = buf.length > MAX_FILE ? buf.subarray(0, MAX_FILE) : buf;
      h.update('file ' + rel + '\n');
      h.update(body);
      h.update('\n');
      files.push({ path: rel, bytes: buf.length });
    } catch { files.push({ path: rel, missing: true }); h.update('missing ' + rel + '\n'); }
  }
  return { hooks, errors, files, hash: raw.length ? h.digest('hex') : '' };
}

// Cache by settings file mtime and the referenced files' mtimes, so a tool
// call does not re-hash the project each time.
const cache = new Map();
function fingerprint(projectDir, files) {
  const settings = require('./settings.js');
  const parts = [];
  try { parts.push(settings.isDbBacked(projectDir) ? 'db:' + JSON.stringify(settings.getProject(projectDir).hooks || null).length : 'file'); } catch { parts.push('?'); }
  try { parts.push(String(fs.statSync(settings.getProjectPath(projectDir)).mtimeMs)); } catch { parts.push('-'); }
  for (const f of files || []) {
    try { parts.push(f.path + ':' + fs.statSync(path.join(projectDir, f.path)).mtimeMs); } catch { parts.push(f.path + ':-'); }
  }
  return parts.join('|');
}
function readCached(projectDir) {
  const hit = cache.get(projectDir);
  if (hit && hit.fp === fingerprint(projectDir, hit.value.files)) return hit.value;
  const value = read(projectDir);
  cache.set(projectDir, { fp: fingerprint(projectDir, value.files), value });
  return value;
}

// Trust rows are keyed by the resolved project path, like project settings.
function dirKey(projectDir) { return path.resolve(String(projectDir || '')); }

function trustedHash(projectDir, key = HOOKS_KEY) {
  try {
    const row = store().prepare('SELECT hash FROM hook_trust WHERE project_dir = ? AND key = ?').get(dirKey(projectDir), key);
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

module.exports = { HOOKS_KEY, canonical, referencedFiles, read, status, active, trust, revoke, append, trustedHash, setTrust,
  _clearCache: () => cache.clear() };
