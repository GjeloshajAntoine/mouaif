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
//   - getProjectPath()          : the project's settings file — either
//                                 <projectDir>/.mouaif/.mouaif.json (folder
//                                 layout, when present) or <projectDir>/.mouaif.json.
//
// Concurrency: better-sqlite3 is synchronous and single-process; we do not
// need transactions beyond what a single prepared statement gives us. The
// in-process write queue is the caller's problem (Node single-thread).

const contentDb = require('./content/db.js');
const stores = require('./content/stores/index.js');
const appDbStore = require('./content/stores/app-db.js');
const projectFile = require('./content/stores/project-file.js');
const projectDb = require('./content/stores/project-db.js');
const jsonFile = require('./content/stores/json-file.js');

const {
  MOUAIF_HOME,
  MCP_TOOL_CACHE_TABLE,
  MIGRATIONS_TABLE,
  PROJECT_SETTINGS_TABLE,
  canonicalProjectDir,
  requireCanonicalProjectDir,
  tableExists,
  db
} = contentDb;
const { PROJECT_FILE, PROJECT_DIR } = projectFile;
const APP_KEY = 'settings';

// Built-in defaults. These are the floor: anything not set in app or project
// falls back to these. Generated from the content registry
// (src/content/registry.js), where each setting declares its own default next
// to its label, scopes and allowlist flags. Deep-frozen: getResolved() clones
// what it merges, so nothing downstream may mutate the floor.
const registry = require('./content/registry.js');
const DEFAULTS = registry.deepFreeze(registry.buildDefaults());

// ---- Model recent store (app DB) -----------------------------------------
//
// One app-wide list of recently used models, capped at 20 entries. It is
// deliberately NOT keyed by project: a model is an app-level resource (its
// provider connection lives in app settings, and the model slug means the same
// thing everywhere), so the same list follows the user across every project
// instead of being rebuilt from scratch in each one. Rows that older builds
// wrote per project are folded onto the single list by the
// `2026-10-07-share-model-bookmarks` migration.
//
// Stored in a dedicated table so the web UI can fetch and update it without
// reading/writing the whole app-level settings object.

const MODEL_RECENT_TABLE = 'model_recent';
const MODEL_RECENT_CAP = 20;

function ensureModelRecentTable() {
  db().exec(
    `CREATE TABLE IF NOT EXISTS ${MODEL_RECENT_TABLE} (
       provider TEXT NOT NULL,
       model_id TEXT NOT NULL,
       ts       INTEGER NOT NULL,
       PRIMARY KEY (provider, model_id)
     );`
  );
}

function getRecentModels() {
  ensureModelRecentTable();
  return db()
    .prepare(
      `SELECT provider, model_id AS id, ts
       FROM ${MODEL_RECENT_TABLE}
       ORDER BY ts DESC
       LIMIT ?`
    )
    .all(MODEL_RECENT_CAP);
}

function touchRecentModel(provider, modelId) {
  if (!provider || !modelId) return;
  ensureModelRecentTable();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO ${MODEL_RECENT_TABLE} (provider, model_id, ts) VALUES (?, ?, ?)
       ON CONFLICT(provider, model_id) DO UPDATE SET ts = excluded.ts`
    )
    .run(provider, modelId, now);
  // Reap any entries beyond the cap (oldest first)
  db()
    .prepare(
      `DELETE FROM ${MODEL_RECENT_TABLE} WHERE rowid NOT IN (
         SELECT rowid FROM ${MODEL_RECENT_TABLE} ORDER BY ts DESC LIMIT ?
       )`
    )
    .run(MODEL_RECENT_CAP);
}

function clearRecentModels() {
  ensureModelRecentTable();
  db().prepare(`DELETE FROM ${MODEL_RECENT_TABLE}`).run();
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
// Keys that are not absolute paths cannot be canonicalized; they are carried
// over verbatim rather than dropped.
//
// `model_recent` is no longer one of these tables: it is app-wide, so a
// directory key means nothing to it. Rows an older build wrote per project are
// folded onto the single list by the `2026-10-07-share-model-bookmarks`
// migration, which does not care how those directories were spelled.

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

  // --- model_recent is not canonicalized here ---------------------------
  // The table is app-wide now and carries no directory key, so there is
  // nothing to normalize. Rows an older build wrote per project are folded
  // onto the single list by the `2026-10-07-share-model-bookmarks` migration.
}

// shareModelBookmarks() — fold per-project recent-model rows onto one list.
//
// `model_recent` used to be keyed by `project_dir`, so the same model appeared
// once per project and the picker's Recent section was rebuilt from scratch in
// every project. The list is now app-wide, and this rewrites the old table
// (dropping the directory key) keeping the newest timestamp per
// (provider, model). The table is rebuilt rather than column-dropped so the
// composite primary key becomes (provider, model_id) on every store, old and
// new, without depending on ALTER TABLE support for that.
//
// Idempotent: a table already in the app-wide shape is left untouched.
function shareModelBookmarks() {
  const d = db();
  const cols = d.prepare(`PRAGMA table_info(${MODEL_RECENT_TABLE})`).all();
  if (!cols.length) return; // created lazily; nothing written yet
  if (!cols.some((c) => c.name === 'project_dir')) return;

  const rows = d.prepare(`SELECT provider, model_id, ts FROM ${MODEL_RECENT_TABLE}`).all();
  const newest = new Map();
  for (const row of rows) {
    const key = row.provider + '\0' + row.model_id;
    const prev = newest.get(key);
    if (!prev || row.ts > prev.ts) newest.set(key, row);
  }
  const replace = d.transaction(() => {
    d.prepare(`DELETE FROM ${MODEL_RECENT_TABLE}`).run();
    d.exec(`DROP TABLE ${MODEL_RECENT_TABLE}`);
    ensureModelRecentTable();
    const insert = d.prepare(
      `INSERT INTO ${MODEL_RECENT_TABLE} (provider, model_id, ts) VALUES (?, ?, ?)`
    );
    for (const row of newest.values()) insert.run(row.provider, row.model_id, row.ts);
  });
  replace();
  // Keep the cap: the fold can merge rows that were each under it.
  const overflow = d.prepare(
    `DELETE FROM ${MODEL_RECENT_TABLE} WHERE rowid NOT IN (
       SELECT rowid FROM ${MODEL_RECENT_TABLE} ORDER BY ts DESC LIMIT ?
     )`
  );
  overflow.run(MODEL_RECENT_CAP);
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
},
{
name: '2026-09-27-snapshot-chat-prompts',
description: 'Pin the custom prompt text already attached to each chat',
run() {
// Chats used to resolve their custom prompt live from `prompt_id`, so
// editing a shared prompt silently rewrote every chat that referenced it.
// Pin the text as it stands right now, which freezes existing chats at the
// behaviour they already have and leaves later edits to new chats only.
//
// `prompt_snapshot` is created by chatdb.ensureChatTables(); migrations run
// at startup before any chat is touched, so the column may not exist yet on
// a brand-new store. A chat whose prompt is already gone is left alone: it
// has nothing to pin, and a NULL snapshot keeps resolving to "no prompt",
// which is what it does today.
require('./chatdb.js').ensureChatTables();
const prompts = require('./prompts.js');
const chats = require('./chats.js');
const d = db();
const rows = d.prepare(
  'SELECT DISTINCT project_dir FROM chat_store WHERE prompt_id IS NOT NULL AND prompt_snapshot IS NULL'
).all();
for (const row of rows) {
const dir = row && row.project_dir;
if (!dir) continue;
let list;
try { list = chats.listChats(dir); } catch { continue; }
for (const chat of list) {
  if (!chat || !chat.promptId || chat.promptSnapshot) continue;
  try {
    const snap = prompts.snapshotPrompt(dir, chat.promptId);
    if (snap) chats.updateChat(dir, chat.id, { promptSnapshot: snap });
  } catch (e) {
    console.error('  [migration] prompt snapshot failed for ' + chat.id + ': ' + e.message);
  }
}
}
}
},
{
name: '2026-10-01-separate-native-app-tools',
description: 'Convert legacy mouaif selections and permissions to ordinary native tools',
run() { require('./migrateAppTools.js').run(); }
},
{
name: '2026-10-07-drop-automatic-workspaces',
description: 'Remove the retired autoWorkspace setting from app settings and every project',
run() {
// `change_working_folder` used to create a default workspace folder under an
// opt-in switch, stored as `autoWorkspace` at app and project level. The tool
// now only ever selects an existing directory, so the key is inert: it is no
// longer in DEFAULTS or CLIENT_SETTINGS_KEYS, but a stored value would still
// sit in `.mouaif.json` (or the app row) looking like a setting that matters.
// Drop it from the app store and from every registered project's raw object.
//
// A project file that cannot be read is left alone rather than cleared: the
// stale key is harmless, and rewriting a file we could not parse would be the
// destructive half of this migration with none of the benefit.
const app = getAppRaw();
if (Object.prototype.hasOwnProperty.call(app, 'autoWorkspace')) {
  const next = { ...app };
  delete next.autoWorkspace;
  setAppReplace(next);
}
let dirs = [];
try { dirs = require('./projects.js').listProjects().map((p) => p && p.path).filter(Boolean); }
catch (e) { console.error('  [migration] project list failed: ' + e.message); }
// Fresh stores create these lazily on first use, and migrations run at
// startup before any chat or project read — so the tables may not exist yet.
// ensureChatTables() creates chat_store; project_settings comes from the
// app-store open path, so a missing table means there is nothing to clean.
require('./chatdb.js').ensureChatTables();
const d = db();
for (const table of ['project_settings', 'chat_store']) {
  if (!tableExists(d, table)) continue;
  for (const row of d.prepare(`SELECT DISTINCT project_dir FROM ${table}`).all()) {
    if (row && row.project_dir) dirs.push(row.project_dir);
  }
}
for (const dir of new Set(dirs)) {
  try {
    const project = getProject(dir);
    if (!project || !Object.prototype.hasOwnProperty.call(project, 'autoWorkspace')) continue;
    unsetProjectKeys(dir, ['autoWorkspace']);
  } catch (e) {
    console.error('  [migration] autoWorkspace cleanup skipped for ' + dir + ': ' + e.message);
  }
}
}
},
{
name: '2026-10-07-share-model-bookmarks',
description: 'Fold the per-project recent-model rows onto one app-wide list',
run() {
shareModelBookmarks();
}
},
{
name: '2026-10-30-fold-get-app-info',
description: 'Rename stored get_app_info selections and permissions to list_features',
run() { const m = require('./migrateAppTools.js'); m.run(m.renameTool('get_app_info', 'list_features')); }
}
];
function runMigrations() {  const d = db();
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

// ---- Shared project-file I/O -------------------------------------------
//
// src/chats.js and src/messages.js read and write JSON files next to the
// project (`.mouaif.json` and the per-chat `.mouaif.messages.<id>.json`);
// they go through these helpers so the format and error contract live in
// one place (src/content/stores/json-file.js).
const { readProjectJson, writeProjectJson } = jsonFile;

// ---- App-level store ----------------------------------------------------

// Expose the shared DB handle so chatdb.js can reuse the same connection.
// Tables are created lazily by both modules; the IF NOT EXISTS clause
// makes the second CREATE a no-op.
function getDb() {
  return db();
}

function appStore() {
  return stores.storeFor('settings', 'app');
}

function getAppRaw() {
  // A corrupt blob is moved aside rather than silently replaced; see
  // src/content/stores/app-db.js.
  return appStore().read();
}

// Every unreadable app-settings value the store has moved aside, oldest key
// first. Each entry is the raw stored text, so a user can recover entries by
// hand (`sqlite3 ~/.mouaif/store.sqlite "SELECT value FROM app_kv WHERE key='...'"`)
// instead of losing them to a silent reset.
function listQuarantinedAppSettings() {
  return appDbStore.listQuarantined(APP_KEY);
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
  return updateApp((current) => ({ ...current, ...patch }));
}

// Update from the latest app document, with no gap between read and write.
// Returning the current object unchanged skips the write.
function updateApp(update) {
  return stores.withWriteLock(() => {
    const store = appStore();
    const current = store.read();
    const next = update(current);
    return next === current ? current : store.write(next);
  });
}

// Replace the whole app-level settings object (no merge). The caller is
// responsible for shape: the new object is stored verbatim.
function setAppReplace(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new TypeError('setAppReplace() expects an object');
  }
  return appStore().write(next);
}

// ---- Project-level store ------------------------------------------------
//
// Where a project's document lives — `.mouaif.json`, `.mouaif/.mouaif.json`
// or a `project_settings` row — is decided by storeFor() alone
// (src/content/stores/index.js). These accessors keep their names for the
// callers that predate it.

const {
  getProjectRootPath,
  getProjectFolderPath,
  getProjectLayout,
  getProjectPath
} = projectFile;

// The project FILE, whatever the project's mode (seeding a mode switch and the
// raw editor read it directly).
function getProjectRaw(projectDir) {
  return stores.storeFor('settings', 'project', projectDir, 'file').read();
}

const getDbProjectRaw = projectDb.readRow;
const isDbBacked = projectDb.isDbBacked;
const deleteDbProject = projectDb.deleteRow;
// Write a project's DB row verbatim (the caller sets `__dbBacked`).
const setDbProject = projectDb.writeRow;

// Opt a project into (or out of) DB-backed settings, moving its documents.
// Opting in copies the project's existing `.mouaif.json` so no hand-written
// setting is silently ignored; opting out writes the DB copy back to the file.
function setDbBacked(projectDir, dbBacked) {
  stores.setProjectMode(projectDir, !!dbBacked);
  return getProject(projectDir);
}

function projectStore(projectDir) {
  return stores.storeFor('settings', 'project', projectDir);
}

function getProject(projectDir) {
  // Raw project object (no defaults, no app merge). A DB-backed project
  // returns its store row verbatim; otherwise the .mouaif.json file.
  return projectStore(projectDir).read();
}

function setProject(projectDir, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('setProject() expects an object patch');
  }
  return stores.withWriteLock(() => {
    const store = projectStore(projectDir);
    return store.write({ ...store.read(), ...patch });
  });
}

function unsetProjectKeys(projectDir, keys) {
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || !key)) {
    throw new TypeError('unsetProjectKeys() expects an array of key names');
  }
  return stores.withWriteLock(() => {
    const store = projectStore(projectDir);
    const next = store.read();
    for (const key of keys) delete next[key];
    return store.write(next);
  });
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
  contentDb.close();
}

module.exports = {
  // introspection
  MOUAIF_HOME,
  PROJECT_FILE,
  PROJECT_DIR,
  PROJECT_SETTINGS_TABLE,
  DEFAULTS,
  // app
  getApp,
  setApp,
  updateApp,
  setAppReplace,
  listQuarantinedAppSettings,
  // project
  getProjectPath,
  getProjectRootPath,
  getProjectFolderPath,
  getProjectLayout,
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
  // one-shot model-bookmark fold (exported for tests)
  shareModelBookmarks,
  // lifecycle (mostly for tests)
  close
};
