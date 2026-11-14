'use strict';

// The app store's SQLite handle (~/.mouaif/store.sqlite) and the helpers every
// store adapter shares: the test-process guard, the table names and project
// directory canonicalization. Moved out of src/settings.js so the content
// stores (src/content/stores/) and settings.js can both use it without a
// require cycle. settings.js re-exports what its callers used.

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const DEFAULT_HOME = path.join(os.homedir(), '.mouaif');
const MOUAIF_HOME = process.env.MOUAIF_HOME || DEFAULT_HOME;
const APP_DB = 'store.sqlite';
const APP_KV_TABLE = 'app_kv';
// Per-project MCP tool caches. Keyed by `${projectDir}::${serverId}` so the
// bulky last-known tool schemas live in the app store instead of the
// hand-editable, project-committed <projectDir>/.mcp.json.
const MCP_TOOL_CACHE_TABLE = 'mcp_tool_cache';
const MIGRATIONS_TABLE = '_migrations';
// Per-project settings stored in the app DB instead of <projectDir>/.mouaif.json.
// Keyed by canonical project directory so a project can opt out of writing the
// JSON file (keeps the working tree untouched). The row shape mirrors the
// project file: the value is the full raw project object.
const PROJECT_SETTINGS_TABLE = 'project_settings';

// A test process must never open the real app store. Test/probe scripts run
// in-process against src/ modules, and a missing — or too-late — MOUAIF_HOME
// used to let them write to ~/.mouaif/store.sqlite: every
// `settings.setApp({ providers: [...] })` then replaced the whole provider
// array and dropped real connections (see the 2026-08-06 incident, fixed for
// the checked-in tests in commit "isolate test app stores"). Refuse the
// default home from a test process so the mistake fails loudly instead of
// corrupting the running instance. The server and CLI are not test processes
// and keep the default home; MOUAIF_ALLOW_REAL_HOME=1 is the deliberate
// override for a one-off run against the real store.
const REPO_SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');
function isTestProcess() {
  if (process.env.NODE_TEST_CONTEXT) return true; // node --test
  if (process.env.MOUAIF_TEST === '1') return true;
  const entry = process.argv[1];
  if (typeof entry !== 'string' || !entry) return false;
  const resolved = path.resolve(entry);
  if (!resolved.startsWith(REPO_SCRIPTS_DIR + path.sep)) return false;
  return /^(test|probe)[-_.]/.test(path.basename(resolved));
}
// A test may spawn a child (`bin/mouaif.js serve`, a pty shell). The child has
// its own argv and would look like the running server, so carry the marker in
// the environment; the child's settings.js then refuses the real home too.
if (isTestProcess()) process.env.MOUAIF_TEST = '1';
// Resolve symlink aliases without creating directories. A fresh test home (or
// the default home) may not exist yet; resolve its nearest existing parent
// and append the missing path components instead.
function canonicalStoreHome(home) {
  const resolved = path.resolve(home);
  try { return fs.realpathSync(resolved); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw err;
    return path.join(canonicalStoreHome(parent), path.basename(resolved));
  }
}
function assertStoreHomeSafe(home) {
  if (process.env.MOUAIF_ALLOW_REAL_HOME === '1') return;
  if (!isTestProcess()) return;
  if (canonicalStoreHome(home) !== canonicalStoreHome(DEFAULT_HOME)) return;
  const err = new Error('Refusing to open the real app store (' + DEFAULT_HOME
    + ') from a test process. Set MOUAIF_HOME to a temp directory before requiring src/settings.js: '
    + 'a test must never read or write the running instance. Use MOUAIF_ALLOW_REAL_HOME=1 only for a '
    + 'deliberate run against the real store.');
  err.code = 'MOUAIF_REAL_HOME_IN_TEST';
  throw err;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---- Project-dir canonicalization --------------------------------------
//
// Every project-scoped table in the app store (project_settings,
// mcp_tool_cache, model_recent) is keyed by the project directory. Callers
// hand us whatever the client sent — `/home/me/app`, `/home/me/app/` or
// `/home/me/app/../app` are three spellings of one directory, and used to be
// three rows. The damage was not only duplicated data: a project could be
// opted into DB-backed settings under a key that no other code path ever
// looked up, so it kept reading `.mouaif.json` and the opt-in appeared to do
// nothing. Keys are therefore normalized to an absolute path at every
// boundary, reads included (a read under a non-canonical key must not find a
// row the write would not have created).
function canonicalProjectDir(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return null;
  if (!path.isAbsolute(projectDir)) return null;
  return path.resolve(projectDir);
}

// Same as canonicalProjectDir(), but for write paths: an unusable directory
// is a programming error there, not a miss.
function requireCanonicalProjectDir(projectDir) {
  const canonical = canonicalProjectDir(projectDir);
  if (!canonical) {
    const e = new TypeError('projectDir must be an absolute path');
    e.code = 'EBADPROJECTDIR';
    throw e;
  }
  return canonical;
}

function openDb(home) {
  ensureDir(home);
  const dbPath = path.join(home, APP_DB);
  // The app DB includes credentials. Restrict the DB before creating WAL/SHM
  // sidecars, whose permissions SQLite derives from the database file.
  const db = new Database(dbPath);
  if (process.platform !== 'win32') fs.chmodSync(dbPath, 0o600);
  db.pragma('journal_mode = WAL');
  if (process.platform !== 'win32') {
    for (const suffix of ['-wal', '-shm']) {
      try { fs.chmodSync(dbPath + suffix, 0o600); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS credentials (
    service TEXT NOT NULL,
    account TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (service, account)
  )`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${APP_KV_TABLE} (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     );`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MCP_TOOL_CACHE_TABLE} (
       project_dir TEXT NOT NULL,
       server_id   TEXT NOT NULL,
       tools       TEXT NOT NULL,
       updated_at  TEXT NOT NULL,
       PRIMARY KEY (project_dir, server_id)
     );`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${PROJECT_SETTINGS_TABLE} (
       project_dir TEXT PRIMARY KEY,
       value       TEXT NOT NULL
     );`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       name       TEXT PRIMARY KEY,
       run_at     TEXT NOT NULL
     );`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
       id         TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       endpoint   TEXT NOT NULL UNIQUE,
       p256dh     TEXT NOT NULL,
       auth       TEXT NOT NULL,
       origin     TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     );`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS push_vapid (
       key        TEXT PRIMARY KEY,
       value      TEXT NOT NULL,
       created_at TEXT NOT NULL
     );`
  );
  return db;
}

// tableExists(d, name) — does this store carry the table yet? Migrations run
// before any chat or project access, so a table created lazily on first use
// (chat_store, project_settings) may legitimately be absent on a fresh store.
function tableExists(d, name) {
  return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

let _appDb = null;
// Bumped on every open and close, so a cached prepared statement or a cached
// document can tell that the handle it was built for is gone.
let _generation = 0;
function db() {
  if (!_appDb) {
    assertStoreHomeSafe(MOUAIF_HOME);
    _appDb = openDb(MOUAIF_HOME);
    _generation++;
  }
  return _appDb;
}

function generation() {
  return _generation;
}

function close() {
  if (_appDb) {
    _appDb.close();
    _appDb = null;
    _generation++;
  }
}

module.exports = {
  MOUAIF_HOME,
  APP_KV_TABLE,
  MCP_TOOL_CACHE_TABLE,
  MIGRATIONS_TABLE,
  PROJECT_SETTINGS_TABLE,
  db,
  generation,
  close,
  tableExists,
  canonicalProjectDir,
  requireCanonicalProjectDir,
  ensureDir
};
