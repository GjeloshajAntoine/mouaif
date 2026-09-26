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
const crypto = require('crypto');
const Database = require('better-sqlite3');

const MOUAIF_HOME = process.env.MOUAIF_HOME || path.join(os.homedir(), '.mouaif');
const PROJECT_FILE = '.mouaif.json';
const APP_DB = 'store.sqlite';
const APP_KV_TABLE = 'app_kv';
const APP_KEY = 'settings';
// Row key prefix for an unreadable app-settings blob that was moved aside
// instead of being silently replaced by defaults. See getAppRaw().
const APP_QUARANTINE_PREFIX = 'settings.corrupt-';
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
  // Default prompt-size profile for new chats. One of 'very-small' | 'average' | 'extensive' | 'chat'.
  promptSize: 'average',
// Composer keyboard default: when true, Enter inserts a newline and the
// send button / Cmd+Ctrl+Enter sends. When false, Enter sends and
// Shift+Enter inserts a newline. App-level; a project may override it.
enterForNewline: true,
// Auto-retry failed turns. When true, the web client transparently
// re-sends a user message once if the request fails before a stream
// starts (network error or an HTTP rejection other than 409).
autoRetry: true,
// Composer file button ("File tools") style. When false the trigger is the
// flat circle that matches the rest of the composer; when true it renders as
// the animated glass "orb" — a shaded sphere with the git counts on a 3D
// folder glyph inside. App-level: a display preference, so it applies to
// every project. See docs/features/file-button-orb.md.
fileOrbButton: false,
  // Which optional tools the composer draws. Both are display preferences
  // (app-level, like `fileOrbButton`) and both default to `true`: the
  // microphone and the image button are the two controls the composer has
  // always shown, and turning one *off* is how a user keeps a button they
  // never use out of the way. Hiding is not disabling — the routes behind
  // them (`/api/ai/transcribe`, image attachments) are untouched. See
  // docs/features/composer-tool-buttons.md.
  dictationButton: true,
  imageButton: true,
  // The one-line status row under the composer. `false` hides its text (the
  // row keeps the safe-area inset, and an error state still shows).
  statusBar: true,
  // App-level custom prompts. Empty by default.
  prompts: [],
  // Tool output profile for file/result text fed back to the model. `size`
  // controls the byte cap (`very-small`, `average`, `full`, `extensive`);
  // `structure` controls the file-listing layout (`tree` default, `json`).
  // Lives in the same default floor so projects without a key resolve to a
  // sane value.
  toolOutput: { size: 'average', structure: 'tree' },
  // Maximum UTF-8 bytes of one tool result copied into model context.
  // The complete result remains available to the UI and transcript.
  toolFeedbackMaxBytes: 64 * 1024,
  // OS-level browser notifications have two user-facing channels: one
  // replaceable ASCII status per chat, plus authorization prompts. Quick
  // actions let the user answer or approve without opening the app.
  // `login` alerts on a new sign-in and is on by default. See
  // src/notifications.js for the authoritative defaults.
  notifications: {
status: true,
authorization: true,
quickActions: true,
login: true
},

  // Server-side flags. Reserved for future toggles (e.g. enableInspector, port...).
  flags: {}
});

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
// boundary in this module, reads included (a read under a non-canonical key
// must not find a row the write would not have created).
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
  const dir = canonicalProjectDir(projectDir);
  if (!dir) return [];
  ensureModelRecentTable();
  const rows = db()
    .prepare(
      `SELECT provider, model_id AS id, ts
       FROM ${MODEL_RECENT_TABLE}
       WHERE project_dir = ?
       ORDER BY ts DESC
       LIMIT ?`
    )
    .all(dir, MODEL_RECENT_CAP);
  return rows;
}

function touchRecentModel(projectDir, provider, modelId) {
  if (!provider || !modelId) return;
  const dir = requireCanonicalProjectDir(projectDir);
  ensureModelRecentTable();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO ${MODEL_RECENT_TABLE} (project_dir, provider, model_id, ts) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_dir, provider, model_id) DO UPDATE SET ts = excluded.ts`
    )
    .run(dir, provider, modelId, now);
  // Reap any entries beyond the cap (oldest first)
  db()
    .prepare(
      `DELETE FROM ${MODEL_RECENT_TABLE} WHERE project_dir = ? AND rowid NOT IN (
         SELECT rowid FROM ${MODEL_RECENT_TABLE} WHERE project_dir = ? ORDER BY ts DESC LIMIT ?
       )`
    )
    .run(dir, dir, MODEL_RECENT_CAP);
}

function clearRecentModels(projectDir) {
  const dir = canonicalProjectDir(projectDir);
  if (!dir) return;
  ensureModelRecentTable();
  db()
    .prepare(`DELETE FROM ${MODEL_RECENT_TABLE} WHERE project_dir = ?`)
    .run(dir);
}

// ---- Legacy key normalization -------------------------------------------
//
// Rows written before the canonicalization fix can hold `/a/b/`, `/a/./b`
// and `/a/c/../b` as three distinct keys for one directory. This rewrites
// each project-scoped table once, merging duplicates deterministically:
//   - project_settings: a row whose value carries `__dbBacked: true` wins
//     (that is the opt-in the user actually made, seeded from their file);
//     otherwise the earliest row wins.
//   - mcp_tool_cache: the most recently updated row wins per server.
//   - model_recent: the newest timestamp wins per (provider, model).
// Keys that are not absolute paths cannot be canonicalized; they are carried
// over verbatim rather than dropped.

function projectKeysNeedRewrite(rows) {
  return rows.some((row) => {
    const dir = canonicalProjectDir(row.project_dir);
    return dir && dir !== row.project_dir;
  });
}

function canonicalizeProjectKeys() {
  const d = db();
  ensureModelRecentTable();

  // --- project_settings -------------------------------------------------
  const projRows = d.prepare(`SELECT rowid, project_dir, value FROM ${PROJECT_SETTINGS_TABLE}`).all();
  if (projectKeysNeedRewrite(projRows)) {
    const groups = new Map();
    for (const row of projRows) {
      const dir = canonicalProjectDir(row.project_dir) || row.project_dir;
      const group = groups.get(dir);
      if (!group) groups.set(dir, [row]);
      else group.push(row);
    }
    const replace = d.transaction(() => {
      d.prepare(`DELETE FROM ${PROJECT_SETTINGS_TABLE}`).run();
      const insert = d.prepare(`INSERT INTO ${PROJECT_SETTINGS_TABLE} (project_dir, value) VALUES (?, ?)`);
      for (const [dir, group] of groups) {
        const winner = group.find((r) => {
          try { return JSON.parse(r.value).__dbBacked === true; } catch { return false; }
        }) || group[0];
        insert.run(dir, winner.value);
      }
    });
    replace();
  }

  // --- mcp_tool_cache ---------------------------------------------------
  const cacheRows = d.prepare(`SELECT project_dir, server_id, tools, updated_at FROM ${MCP_TOOL_CACHE_TABLE}`).all();
  if (projectKeysNeedRewrite(cacheRows)) {
    const groups = new Map();
    for (const row of cacheRows) {
      const dir = canonicalProjectDir(row.project_dir) || row.project_dir;
      const key = dir + '\0' + row.server_id;
      const prev = groups.get(key);
      if (!prev || String(row.updated_at) > String(prev.updated_at)) {
        groups.set(key, { ...row, project_dir: dir });
      }
    }
    const replace = d.transaction(() => {
      d.prepare(`DELETE FROM ${MCP_TOOL_CACHE_TABLE}`).run();
      const insert = d.prepare(
        `INSERT INTO ${MCP_TOOL_CACHE_TABLE} (project_dir, server_id, tools, updated_at) VALUES (?, ?, ?, ?)`
      );
      for (const row of groups.values()) {
        insert.run(row.project_dir, row.server_id, row.tools, row.updated_at);
      }
    });
    replace();
  }

  // --- model_recent -----------------------------------------------------
  const recentRows = d.prepare(`SELECT project_dir, provider, model_id, ts FROM ${MODEL_RECENT_TABLE}`).all();
  if (projectKeysNeedRewrite(recentRows)) {
    const groups = new Map();
    for (const row of recentRows) {
      const dir = canonicalProjectDir(row.project_dir) || row.project_dir;
      const key = dir + '\0' + row.provider + '\0' + row.model_id;
      const prev = groups.get(key);
      if (!prev || row.ts > prev.ts) groups.set(key, { ...row, project_dir: dir });
    }
    const replace = d.transaction(() => {
      d.prepare(`DELETE FROM ${MODEL_RECENT_TABLE}`).run();
      const insert = d.prepare(
        `INSERT INTO ${MODEL_RECENT_TABLE} (project_dir, provider, model_id, ts) VALUES (?, ?, ?, ?)`
      );
      for (const row of groups.values()) {
        insert.run(row.project_dir, row.provider, row.model_id, row.ts);
      }
    });
    replace();
  }
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
// Non-fatal — one inaccessible project should not block startup.
// Registering/importing it later seeds the totals again.
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
},
{
name: '2026-08-26-persist-chat-cost-totals',
description: 'Persist chat and registered-project cost totals',
run() {
const projects = require('./projects.js').listProjects();
const chats = require('./chats.js');
for (const project of projects) {
if (!project || !project.path) continue;
try { chats.recomputeProjectTotalCost(project.path); }
catch (e) { console.error('  [migration] cost total failed for ' + project.path + ': ' + e.message); }
}
}
},
{
name: '2026-09-12-canonicalize-project-keys',
description: 'Normalize project directory keys in the project-scoped app tables',
run() {
canonicalizeProjectKeys();
}
},
{
name: '2026-09-26-drop-seeded-chat-prompt',
description: 'Remove the retired auto-seeded Chat prompt and promptsSeeded flag from app settings',
run() {
// An earlier commit seeded a built-in "Chat" prompt (id `chat`, empty
// content, an exclusive empty-tool preset) into app settings and set a
// `promptsSeeded` flag so a deleted default would not come back. That
// behaviour was reverted, but the value it wrote is still stored, so the
// picker keeps listing a prompt the code no longer creates. Drop the flag
// and any still-empty `chat` prompt. A prompt the user gave content to is
// kept: the id must still match and the content must still be empty.
const app = getAppRaw();
const hasFlag = Object.prototype.hasOwnProperty.call(app, 'promptsSeeded');
const list = Array.isArray(app.prompts) ? app.prompts : null;
const isSeededChat = (p) => p && p.id === 'chat'
  && typeof p.content === 'string' && !p.content.trim();
const seeded = !!list && list.some(isSeededChat);
if (!hasFlag && !seeded) return;
const next = { ...app };
delete next.promptsSeeded;
if (seeded) next.prompts = list.filter((p) => !isSeededChat(p));
// setAppReplace() writes the object as-is, so the deleted key stays deleted.
setAppReplace(next);
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
  const body = JSON.stringify(obj, null, 2) + '\n';
  // Stage next to the target, fsync, then rename over it. A bare
  // writeFileSync that dies mid-write (crash, full disk, killed process)
  // leaves a truncated `.mouaif.json` behind, and a truncated project file is
  // not a small failure: readProjectJson() reports
  // MOUAIF_PROJECT_PARSE_ERROR, so settings AND every chat route for that
  // project answer 422 until the user repairs the file by hand. rename(2) is
  // atomic within a directory, so a reader sees either the old file or the
  // complete new one. The staging name is unique per write so two processes
  // cannot clobber each other's, and it is removed on failure.
  const tmpPath = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
    throw e;
  }
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
  const d = db();
  const row = d.prepare(`SELECT value FROM ${APP_KV_TABLE} WHERE key = ?`).get(APP_KEY);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('app settings must be a JSON object');
    }
    return parsed;
  } catch (e) {
    // A corrupt app-settings blob used to resolve to {}: every provider,
    // registered project, prompt and pricing entry vanished from the UI, and
    // the next write persisted that emptiness over the only copy. Move the
    // unreadable value aside instead — it stays in the store under a
    // quarantine key, the live row is reset, and the failure is reported.
    const quarantineKey = APP_QUARANTINE_PREFIX + new Date().toISOString().replace(/[:.]/g, '-')
      + '-' + crypto.randomBytes(3).toString('hex');
    try {
      d.transaction(() => {
        d.prepare(`INSERT OR REPLACE INTO ${APP_KV_TABLE} (key, value) VALUES (?, ?)`)
          .run(quarantineKey, row.value);
        d.prepare(`DELETE FROM ${APP_KV_TABLE} WHERE key = ?`).run(APP_KEY);
      })();
      console.error('[settings] app settings were unreadable (' + e.message
        + '); the stored value was preserved as ' + quarantineKey
        + ' and settings start from defaults. See listQuarantinedAppSettings().');
    } catch (quarantineError) {
      console.error('[settings] app settings were unreadable (' + e.message
        + ') and could not be quarantined: ' + quarantineError.message);
    }
    return {};
  }
}

// Every unreadable app-settings value the store has moved aside, oldest key
// first. Each entry is the raw stored text, so a user can recover entries by
// hand (`sqlite3 ~/.mouaif/store.sqlite "SELECT value FROM app_kv WHERE key='...'"`)
// instead of losing them to a silent reset.
function listQuarantinedAppSettings() {
  return db()
    .prepare(`SELECT key, value FROM ${APP_KV_TABLE} WHERE key LIKE ? ORDER BY key`)
    .all(APP_QUARANTINE_PREFIX + '%');
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
  const dir = canonicalProjectDir(projectDir);
  if (!dir) return null;
  return db()
    .prepare(`SELECT value FROM ${PROJECT_SETTINGS_TABLE} WHERE project_dir = ?`)
    .get(dir) || null;
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
  const dir = requireCanonicalProjectDir(projectDir);
  db()
    .prepare(
      `INSERT INTO ${PROJECT_SETTINGS_TABLE} (project_dir, value) VALUES (?, ?)
ON CONFLICT(project_dir) DO UPDATE SET value = excluded.value`
    )
    .run(dir, JSON.stringify(next));
  return next;
}
// Remove a project's DB-backed settings row entirely. Canonicalizes the key
// like every other project-scoped write so a non-canonical spelling (trailing
// slash, `..` segment) still targets the row the opt-in created. Toggling a
// project back to file-backed storage deletes the row through here; a bare
// `DELETE ... WHERE project_dir = ?` on the raw request path would miss it and
// leave the project reading stale DB settings.
function deleteDbProject(projectDir) {
  const dir = canonicalProjectDir(projectDir);
  if (!dir) return;
  db()
    .prepare(`DELETE FROM ${PROJECT_SETTINGS_TABLE} WHERE project_dir = ?`)
    .run(dir);
}
function setDbBacked(projectDir, dbBacked) {
  // Opting in seeds from the project's existing `.mouaif.json` (when there is
  // no DB row yet) so no hand-written setting is silently ignored. This is the
  // same guarantee the storage toggle documents; the register-time opt-in used
  // to write a bare `{ __dbBacked: true }` and leave every project setting
  // behind in the file it had just stopped reading.
  const hasRow = !!projectSettingsRow(projectDir);
  const next = dbBacked
    ? { ...(hasRow ? getDbProjectRaw(projectDir) : getProjectRaw(projectDir)), __dbBacked: true }
    : { ...getDbProjectRaw(projectDir) };
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

// Deep copy of a settings value. Used by deepMerge so the resolved object is a
// fresh tree.
function cloneSettingValue(value) {
  if (Array.isArray(value)) return value.map(cloneSettingValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneSettingValue(value[key]);
    return out;
  }
  return value;
}

// Deep-merge for plain objects only. Arrays and primitives are replaced, not
// concatenated. Project values win on conflict.
//
// The result never aliases `base` or `override`. That matters because
// `getResolved()` merges the frozen DEFAULTS object as its base: keys absent
// from the override used to be carried over by reference, so
// `getResolved(dir).toolOutput` WAS `DEFAULTS.toolOutput` and a single
// mutation downstream (the resolve a caller is allowed to edit before use)
// poisoned the in-code defaults for every project until restart.
function deepMerge(base, override) {
  if (!isPlainObject(base)) return cloneSettingValue(override);
  if (!isPlainObject(override)) return cloneSettingValue(override);
  const out = {};
  for (const key of Object.keys(base)) out[key] = cloneSettingValue(base[key]);
  for (const key of Object.keys(override)) {
    out[key] = isPlainObject(base[key]) && isPlainObject(override[key])
      ? deepMerge(base[key], override[key])
      : cloneSettingValue(override[key]);
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
  const dir = canonicalProjectDir(projectDir);
  if (!dir) return null;
  const row = db()
    .prepare(`SELECT tools FROM ${MCP_TOOL_CACHE_TABLE} WHERE project_dir = ? AND server_id = ?`)
    .get(dir, serverId);
  if (!row) return null;
  try { return JSON.parse(row.tools); } catch { return null; }
}

function setMcpToolCache(projectDir, serverId, tools) {
  if (!Array.isArray(tools)) throw new TypeError('tools must be an array');
  const dir = requireCanonicalProjectDir(projectDir);
  db()
    .prepare(
      `INSERT INTO ${MCP_TOOL_CACHE_TABLE} (project_dir, server_id, tools, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_dir, server_id)
       DO UPDATE SET tools = excluded.tools, updated_at = excluded.updated_at`
    )
    .run(dir, serverId, JSON.stringify(tools), new Date().toISOString());
}

function deleteMcpToolCache(projectDir, serverId) {
  const dir = canonicalProjectDir(projectDir);
  if (!dir) return;
  db()
    .prepare(`DELETE FROM ${MCP_TOOL_CACHE_TABLE} WHERE project_dir = ? AND server_id = ?`)
    .run(dir, serverId);
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
  listQuarantinedAppSettings,
  // project
  getProjectPath,
  getProject,
  getProjectRaw,
  setProject,
  setDbProject,
  deleteDbProject,
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
  // project-dir canonicalization (exported for the migration + tests)
  canonicalProjectDir,
  // lifecycle (mostly for tests)
  close
};
