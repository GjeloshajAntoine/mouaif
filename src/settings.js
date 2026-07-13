'use strict';

// App + project settings store.
//
// Decisions implemented here:
//   docs/decisions.md §1 — app-level settings live in ~/.mouaif/store.sqlite
//                          (managed by better-sqlite3); project-level settings
//                          live in <projectDir>/.mouaif.json.
//   docs/decisions.md §2 — resolution order: defaults -> app -> project.
//                          Project wins on conflict.
//
// The store is intentionally minimal. It exposes:
//   - getDefaults()             : built-in defaults (in-code, not stored).
//   - getApp() / setApp()       : the whole app-level settings object.
//   - getProject(dir) / set()   : one project, resolved (merged) or raw.
//   - getProjectPath()          : the canonical <projectDir>/.mouaif.json path.
//
// Concurrency: better-sqlite3 is synchronous and single-process; we do not
// need transactions beyond what a single prepared statement gives us. The
// in-process write queue is the caller's problem (Node single-thread).

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const MOUAIF_HOME = process.env.MOUAIF_HOME || path.join(os.homedir(), '.mouaif');
const PROJECT_FILE = '.mouaif.json';
const APP_DB = 'store.sqlite';
const APP_KV_TABLE = 'app_kv';
const APP_KEY = 'settings';

// Built-in defaults. These are the floor: anything not set in app or project
// falls back to these. They are intentionally tiny for the first commit; later
// features (models, prompts, prompt-size profile, trace default, ...) extend
// this object.
const DEFAULTS = Object.freeze({
  // User-defined models. Shape: { id, provider, label, baseUrl, apiKey, contextWindow }.
  // Empty by default. The user adds entries via /api/models.
  models: [],
  // Registered projects. Shape: { id, path, name, createdAt }. Filled in by
  // src/projects.js when the user picks a folder. Empty by default.
  projects: [],
  // Non-secret account index for OAuth sign-ins. Shape:
  //   { openai: ['me@example.com'], anthropic: [], google: [], 'github-copilot': [] }
  // The actual tokens live in the OS keychain via src/auth.js.
  authAccounts: {},
  // Default prompt-size profile for new chats. One of 'very-small' | 'average' | 'extensive'.
  promptSize: 'average',
  // Default trace-to-file state for new chats. Per-chat toggle overrides.
  traceByDefault: false,
  // Server-side flags. Reserved for future toggles (e.g. enableInspector, port...).
  flags: {}
});

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function openDb(home) {
  ensureDir(home);
  const dbPath = path.join(home, APP_DB);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${APP_KV_TABLE} (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     );`
  );
  return db;
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeJsonFile(filePath, obj) {
  ensureDir(path.dirname(filePath));
  // 2-space indent so the file is hand-editable and diff-friendly.
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ---- App-level store ----------------------------------------------------

let _appDb = null;
function db() {
  if (!_appDb) _appDb = openDb(MOUAIF_HOME);
  return _appDb;
}

function getAppRaw() {
  const row = db().prepare(`SELECT value FROM ${APP_KV_TABLE} WHERE key = ?`).get(APP_KEY);
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}

function getApp() {
  // Returns the full app-level object as stored. Defaults are NOT merged in
  // here; getResolved() does that.
  return getAppRaw();
}

function setApp(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('setApp() expects an object patch');
  }
  const current = getAppRaw();
  const next = { ...current, ...patch };
  const json = JSON.stringify(next);
  db()
    .prepare(
      `INSERT INTO ${APP_KV_TABLE} (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(APP_KEY, json);
  return next;
}

// Replace the whole app-level settings object (no merge). Used by
// /api/settings/app/reset where the caller wants to drop specific keys
// rather than merge into them. The caller is responsible for shape:
// the new object is stored verbatim.
function setAppReplace(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new TypeError('setAppReplace() expects an object');
  }
  const json = JSON.stringify(next);
  db()
    .prepare(
      `INSERT INTO ${APP_KV_TABLE} (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(APP_KEY, json);
  return next;
}

// ---- Project-level store ------------------------------------------------

function getProjectPath(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('projectDir must be a non-empty string');
  }
  return path.join(projectDir, PROJECT_FILE);
}

function getProjectRaw(projectDir) {
  const file = getProjectPath(projectDir);
  if (!fs.existsSync(file)) return {};
  try { return readJsonFile(file); } catch (e) {
    // A corrupt project file is a user error. Surface it clearly rather than
    // silently returning {} — the caller can decide to ignore.
    const err = new Error(`Failed to parse ${file}: ${e.message}`);
    err.code = 'MOUAIF_PROJECT_PARSE_ERROR';
    err.cause = e;
    throw err;
  }
}

function getProject(projectDir) {
  // Raw project object (no defaults, no app merge).
  return getProjectRaw(projectDir);
}

function setProject(projectDir, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('setProject() expects an object patch');
  }
  const current = getProjectRaw(projectDir);
  const next = { ...current, ...patch };
  writeJsonFile(getProjectPath(projectDir), next);
  return next;
}

// ---- Resolution ---------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge for plain objects only. Arrays and primitives are replaced, not
// concatenated. Project values win on conflict.
function deepMerge(base, override) {
  if (!isPlainObject(base)) return override;
  if (!isPlainObject(override)) return override;
  const out = { ...base };
  for (const k of Object.keys(override)) {
    out[k] = deepMerge(base[k], override[k]);
  }
  return out;
}

function getResolved(projectDir) {
  // Order: defaults -> app -> project. Project wins.
  const app = getAppRaw();
  const project = projectDir ? getProjectRaw(projectDir) : {};
  return deepMerge(deepMerge(DEFAULTS, app), project);
}

function close() {
  if (_appDb) {
    _appDb.close();
    _appDb = null;
  }
}

module.exports = {
  // introspection
  MOUAIF_HOME,
  PROJECT_FILE,
  DEFAULTS,
  // app
  getApp,
  setApp,
  setAppReplace,
  // project
  getProjectPath,
  getProject,
  setProject,
  // resolution
  getResolved,
  // lifecycle (mostly for tests)
  close
};
