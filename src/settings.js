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
const PROJECT_SETTINGS_KEY = '__project_settings__';

// Built-in defaults. These are the floor: anything not set in app or project
// falls back to these. They are intentionally tiny for the first commit; later
// features (models, prompts, prompt-size profile, trace default, ...) extend
// this object.
const DEFAULTS = Object.freeze({
  // App-level provider connections. Shape:
  //   { id, baseUrl, apiKey, auth, oauthAccount }
  // Models reference one of these provider ids from project settings.
  providers: [],
  // User-defined project models. Shape: { id, provider, label, contextWindow }.
  // Kept in defaults so projects without a models key resolve to an empty list.
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
  // App-level custom prompts. Empty by default.
  prompts: [],
  // Tool output profile for file/result text fed back to the model. `size`
  // controls the byte cap (`very-small`, `average`, `full`, `extensive`);
  // `structure` controls the layout (`full`, `concise`). Lives in the same
  // default floor so projects without a key resolve to a sane value.
  toolOutput: { size: 'average', structure: 'full' },
  // Maximum UTF-8 bytes of one tool result copied into model context.
  // The complete result remains available to the UI and transcript.
  toolFeedbackMaxBytes: 64 * 1024,
  // OS-level browser notifications. Attention events are on by default;
  // quick actions let the user answer simple questions or approve once
  // without opening the app.
  notifications: {
    askUser: true,
    toolAuthorization: true,
    completion: true,
    errors: true,
    quickActions: true
  },
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

// ---- Model recent store (app DB) -----------------------------------------
//
// Per-project list of recently used models, capped at 20 entries per project.
// Stored in a dedicated table so the web UI can fetch and update it without
// reading/writing the whole app-level settings object.

const MODEL_RECENT_TABLE = 'model_recent';
const MODEL_RECENT_CAP = 20;

function ensureModelRecentTable() {
  db().exec(
    `CREATE TABLE IF NOT EXISTS ${MODEL_RECENT_TABLE} (
       project_dir TEXT NOT NULL,
       provider    TEXT NOT NULL,
       model_id    TEXT NOT NULL,
       ts          INTEGER NOT NULL,
       PRIMARY KEY (project_dir, provider, model_id)
     );`
  );
}

function getRecentModels(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return [];
  ensureModelRecentTable();
  const rows = db()
    .prepare(
      `SELECT provider, model_id AS id, ts
       FROM ${MODEL_RECENT_TABLE}
       WHERE project_dir = ?
       ORDER BY ts DESC
       LIMIT ?`
    )
    .all(projectDir, MODEL_RECENT_CAP);
  return rows;
}

function touchRecentModel(projectDir, provider, modelId) {
  if (!projectDir || !provider || !modelId) return;
  ensureModelRecentTable();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO ${MODEL_RECENT_TABLE} (project_dir, provider, model_id, ts) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_dir, provider, model_id) DO UPDATE SET ts = excluded.ts`
    )
    .run(projectDir, provider, modelId, now);
  // Reap any entries beyond the cap (oldest first)
  db()
    .prepare(
      `DELETE FROM ${MODEL_RECENT_TABLE} WHERE project_dir = ? AND rowid NOT IN (
         SELECT rowid FROM ${MODEL_RECENT_TABLE} WHERE project_dir = ? ORDER BY ts DESC LIMIT ?
       )`
    )
    .run(projectDir, projectDir, MODEL_RECENT_CAP);
}

function clearRecentModels(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return;
  ensureModelRecentTable();
  db()
    .prepare(`DELETE FROM ${MODEL_RECENT_TABLE} WHERE project_dir = ?`)
    .run(projectDir);
}

// ---- Migrations ----------------------------------------------------------
//
// Each migration is an idempotent function keyed by name. The `_migrations`
// table tracks which have run. New migrations are appended to the list;
// never modify or remove an existing entry.

const MIGRATIONS = [
  {
    name: '2025-07-17-persist-project-total-cost',
    description: 'Persist totalCost field on every registered project\'s .mouaif.json',
    async run() {
      const projects = require('./projects.js').listProjects();
      const chats = require('./chats.js');
      for (const p of projects) {
        if (!p || !p.path) continue;
        try {
          chats.recomputeProjectTotalCost(p.path);
        } catch (e) {
          // Non-fatal — a corrupt project file shouldn't block the whole
          // migration. The field will be set on the next stream/delete.
          console.error('  [migration] cost total failed for ' + p.path + ': ' + e.message);
        }
      }
    }
  },
  {
    name: '2026-07-23-drop-unused-client-domains',
    description: 'Remove the unused client domains table',
    run() {
      db().exec('DROP TABLE IF EXISTS client_domains');
    }
  },
  {
    name: '2026-07-27-add-thinking-level',
    description: 'Add thinking_level column to chat_store for existing databases',
    run() {
      // Ensure the chat tables exist first. Fresh installs create them lazily
      // on first chat access, but migrations run at startup before any chat is
      // touched, so a brand-new DB has no chat_store yet (the retired import
      // migration used to create it). Guard so the column ALTER doesn't 404.
      require('./chatdb.js').ensureChatTables();
      const d = db();
      const cols = d.prepare("PRAGMA table_info('chat_store')").all();
      const hasCol = cols.some((c) => c.name === 'thinking_level');
      if (!hasCol) {
        d.exec("ALTER TABLE chat_store ADD COLUMN thinking_level TEXT DEFAULT ''");
      }
    }
  },
  {
    name: '2026-07-28-add-max-output-tokens',
    description: 'Add max_output_tokens column to chat_store for existing databases',
    run() {
      require('./chatdb.js').ensureChatTables();
      const d = db();
      const cols = d.prepare("PRAGMA table_info('chat_store')").all();
      const hasCol = cols.some((c) => c.name === 'max_output_tokens');
      if (!hasCol) {
        d.exec("ALTER TABLE chat_store ADD COLUMN max_output_tokens TEXT DEFAULT ''");
      }
    }
  },
{
  name: '2026-08-16-add-draft-attachments',
  description: 'Add draft_attachments column to chat_store for pending composer image drafts',
  run() {
    require('./chatdb.js').ensureChatTables();
    const d = db();
    const cols = d.prepare("PRAGMA table_info('chat_store')").all();
    const hasCol = cols.some((c) => c.name === 'draft_attachments');
    if (!hasCol) {
      d.exec("ALTER TABLE chat_store ADD COLUMN draft_attachments TEXT");
    }
  }
}
];

function runMigrations() {
  const d = db();
  const ran = new Set();
  for (const row of d.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).iterate()) {
    ran.add(row.name);
  }
  const insert = d.prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (name, run_at) VALUES (?, ?)`);
  for (const m of MIGRATIONS) {
    if (ran.has(m.name)) continue;
    console.log('[migration] ' + m.name + ' — ' + m.description);
    m.run();
    insert.run(m.name, new Date().toISOString());
    console.log('[migration] ' + m.name + ' done');
  }
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

// ---- Shared project-file I/O -------------------------------------------
//
// Single source of truth for the on-disk project-file contract (see
// docs/features/app-and-project-settings.md): 2-space indented JSON,
// trailing LF, missing file treated as {}, corrupt file surfaced as a
// MOUAIF_PROJECT_PARSE_ERROR. Both src/chats.js and src/messages.js
// read/write JSON files next to the project (`.mouaif.json` and the
// per-chat `.mouaif.messages.<id>.json`); they go through these helpers
// so the format and error contract live in one place.

// Read and JSON-parse an arbitrary project-relative JSON file. Missing
// file returns `fallback` (default {}). A corrupt file throws with
// code 'MOUAIF_PROJECT_PARSE_ERROR' so the HTTP layer can map it to 422.
function readProjectJson(filePath, fallback) {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError('filePath must be a non-empty string');
  }
  if (!fs.existsSync(filePath)) return fallback === undefined ? {} : fallback;
  try { return readJsonFile(filePath); }
  catch (e) {
    const err = new Error('Failed to parse ' + filePath + ': ' + e.message);
    err.code = 'MOUAIF_PROJECT_PARSE_ERROR';
    err.cause = e;
    throw err;
  }
}

// Write an object to a project-relative JSON file in the canonical
// format (2-space indent, trailing LF), creating parent dirs as needed.
function writeProjectJson(filePath, obj) {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError('filePath must be a non-empty string');
  }
  writeJsonFile(filePath, obj);
}

// ---- App-level store ----------------------------------------------------

let _appDb = null;
function db() {
  if (!_appDb) _appDb = openDb(MOUAIF_HOME);
  return _appDb;
}

// Expose the shared DB handle so chatdb.js can reuse the same connection.
// Tables are created lazily by both modules; the IF NOT EXISTS clause
// makes the second CREATE a no-op. The chat/message tables are created
// in chatdb.js so this module doesn't need to know about them.
function getDb() {
  return db();
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
  // A corrupt project file is a user error. readProjectJson surfaces it as
  // MOUAIF_PROJECT_PARSE_ERROR; a missing file resolves to {}.
  return readProjectJson(getProjectPath(projectDir));
}

// ---- DB-backed project settings ----------------------------------------
// When a project opts out of the JSON file, its settings live here instead
// of <projectDir>/.mouaif.json so the working tree is never touched. The
// value is the same raw project object the file would have carried.
function projectSettingsRow(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return null;
  return db()
    .prepare(`SELECT value FROM ${PROJECT_SETTINGS_TABLE} WHERE project_dir = ?`)
    .get(projectDir) || null;
}
function getDbProjectRaw(projectDir) {
  const row = projectSettingsRow(projectDir);
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}
function isDbBacked(projectDir) {
  const row = projectSettingsRow(projectDir);
  if (!row) return false;
  try { return JSON.parse(row.value).__dbBacked === true; } catch { return false; }
}
function setDbProject(projectDir, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new TypeError('setDbProject() expects an object');
  }
  db()
    .prepare(
      `INSERT INTO ${PROJECT_SETTINGS_TABLE} (project_dir, value) VALUES (?, ?)
ON CONFLICT(project_dir) DO UPDATE SET value = excluded.value`
    )
    .run(projectDir, JSON.stringify(next));
  return next;
}
function setDbBacked(projectDir, dbBacked) {
  const next = { ...getDbProjectRaw(projectDir), __dbBacked: !!dbBacked };
  if (!dbBacked) delete next.__dbBacked;
  setDbProject(projectDir, next);
  return next;
}

function getProject(projectDir) {
  // Raw project object (no defaults, no app merge). A DB-backed project
  // returns its store row verbatim; otherwise the .mouaif.json file.
  if (isDbBacked(projectDir)) return getDbProjectRaw(projectDir);
  return getProjectRaw(projectDir);
}

function setProject(projectDir, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('setProject() expects an object patch');
  }
  if (isDbBacked(projectDir)) {
    return setDbProject(projectDir, { ...getDbProjectRaw(projectDir), ...patch });
  }
  const current = getProjectRaw(projectDir);
  const next = { ...current, ...patch };
  writeProjectJson(getProjectPath(projectDir), next);
  return next;
}

function unsetProjectKeys(projectDir, keys) {
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || !key)) {
    throw new TypeError('unsetProjectKeys() expects an array of key names');
  }
  if (isDbBacked(projectDir)) {
    const next = getDbProjectRaw(projectDir);
    for (const key of keys) delete next[key];
    return setDbProject(projectDir, next);
  }
  const next = getProjectRaw(projectDir);
  for (const key of keys) delete next[key];
  writeProjectJson(getProjectPath(projectDir), next);
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
  const project = projectDir ? getProject(projectDir) : {};
  return deepMerge(deepMerge(DEFAULTS, app), project);
}

// ---- MCP tool cache (app DB) -------------------------------------------
//
// The last-known tool list of each MCP server, persisted so a stopped
// server still advertises its surface. Runtime data, not config — that's
// why it lives here and not in <projectDir>/.mcp.json.

function getMcpToolCache(projectDir, serverId) {
  const row = db()
    .prepare(`SELECT tools FROM ${MCP_TOOL_CACHE_TABLE} WHERE project_dir = ? AND server_id = ?`)
    .get(projectDir, serverId);
  if (!row) return null;
  try { return JSON.parse(row.tools); } catch { return null; }
}

function setMcpToolCache(projectDir, serverId, tools) {
  if (!Array.isArray(tools)) throw new TypeError('tools must be an array');
  db()
    .prepare(
      `INSERT INTO ${MCP_TOOL_CACHE_TABLE} (project_dir, server_id, tools, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_dir, server_id)
       DO UPDATE SET tools = excluded.tools, updated_at = excluded.updated_at`
    )
    .run(projectDir, serverId, JSON.stringify(tools), new Date().toISOString());
}

function deleteMcpToolCache(projectDir, serverId) {
  db()
    .prepare(`DELETE FROM ${MCP_TOOL_CACHE_TABLE} WHERE project_dir = ? AND server_id = ?`)
    .run(projectDir, serverId);
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
  PROJECT_SETTINGS_TABLE,
  DEFAULTS,
  // app
  getApp,
  setApp,
  setAppReplace,
  // project
  getProjectPath,
  getProject,
  getProjectRaw,
  setProject,
  setDbProject,
  unsetProjectKeys,
  getDbProjectRaw,
  isDbBacked,
  setDbBacked,
  // shared project-file I/O (used by chats.js / messages.js)
  readProjectJson,
  writeProjectJson,
  // resolution
  getResolved,
  // shared SQLite DB handle (used by chatdb.js)
  getDb,
  // MCP tool cache (app DB)
  getMcpToolCache,
  setMcpToolCache,
  deleteMcpToolCache,
  // model recent (app DB)
  getRecentModels,
  touchRecentModel,
  clearRecentModels,
  // migrations
  runMigrations,
  // lifecycle (mostly for tests)
  close
};
