'use strict';

// Per-chat hooks (docs/features/hooks.md, spec phase 3).
//
// A chat can carry its own hooks, the way it carries its own webhook. They
// have the same shape as app hooks (src/hooks.js normalizeHook), fire only for
// that chat's turns (and its subagents' tool calls when the hook opts in) and
// run after the app hooks. The user adds them from the chat's hooks panel or
// by allowing the model's `hook_create` card; deleting the chat deletes them;
// forking or duplicating a chat does not copy them (they live in their own
// table, keyed by chat).
//
//   chat_hook (project_dir, chat_id, hook_id) -> entry JSON, created_by
//   ('user' | 'model'), created_at, status ('active' | 'paused'), position

const MAX_PER_CHAT = 20;
const STATUSES = Object.freeze(['active', 'paused']);
const CREATORS = Object.freeze(['user', 'model']);

const CREATE = `
  CREATE TABLE IF NOT EXISTS chat_hook (
    project_dir TEXT NOT NULL,
    chat_id     TEXT NOT NULL,
    hook_id     TEXT NOT NULL,
    entry       TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    status      TEXT NOT NULL,
    position    INTEGER NOT NULL,
    PRIMARY KEY (project_dir, chat_id, hook_id)
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

function fail(message, status = 400) {
  const HookError = hooksMod().HookError;
  return new HookError(message, status);
}

// A stored row as the API and the model see it.
function present(row) {
  let hook;
  try { hook = hooksMod().normalizeHook(JSON.parse(row.entry)); }
  catch { return null; }
  hook.id = row.hook_id;
  hook.enabled = row.status === 'active';
  return { hook, createdBy: row.created_by, createdAt: row.created_at, status: row.status };
}

function rows(projectDir, chatId) {
  return store().prepare('SELECT * FROM chat_hook WHERE project_dir = ? AND chat_id = ? ORDER BY position, created_at')
    .all(projectDir, chatId);
}

// list(projectDir, chatId) -> [{ hook, createdBy, createdAt, status }]
function list(projectDir, chatId) {
  if (!projectDir || !chatId) return [];
  return rows(projectDir, chatId).map(present).filter(Boolean);
}

// active(projectDir, chatId) -> [hook] — what runHooks adds after the app hooks.
function active(projectDir, chatId) {
  return list(projectDir, chatId).filter((x) => x.status === 'active').map((x) => x.hook);
}

function get(projectDir, chatId, hookId) {
  const row = store().prepare('SELECT * FROM chat_hook WHERE project_dir = ? AND chat_id = ? AND hook_id = ?')
    .get(projectDir, chatId, hookId);
  return row ? present(row) : null;
}

// An id not used by this chat's hooks nor by an app hook, so a hook line
// on a tool card names one hook.
function freeId(base, projectDir, chatId) {
  const taken = new Set(rows(projectDir, chatId).map((r) => r.hook_id));
  try { for (const h of hooksMod().getConfig().list) taken.add(h.id); } catch { /* app store down */ }
  const stem = String(base || '').slice(0, 34) || hooksMod().newId();
  if (!taken.has(stem)) return stem;
  for (let i = 2; i < 1000; i++) if (!taken.has(stem + '-' + i)) return stem + '-' + i;
  return hooksMod().newId();
}

// add(projectDir, chatId, raw, createdBy) -> { hook, createdBy, createdAt, status }
// Validates like an app hook. The id is kept when free, otherwise suffixed.
function add(projectDir, chatId, raw, createdBy = 'user') {
  if (!projectDir || !chatId) throw fail('a chat hook needs projectDir and chatId');
  if (!CREATORS.includes(createdBy)) throw fail('createdBy must be user or model');
  const hook = hooksMod().normalizeHook(Object.assign({}, raw, { id: raw && raw.id ? raw.id : hooksMod().newId() }));
  const existing = rows(projectDir, chatId);
  if (existing.length >= MAX_PER_CHAT) throw fail('a chat has at most ' + MAX_PER_CHAT + ' hooks', 409);
  hook.id = freeId(hook.id, projectDir, chatId);
  hook.enabled = true;
  const position = existing.reduce((m, r) => Math.max(m, r.position), -1) + 1;
  store().prepare(`INSERT INTO chat_hook (project_dir, chat_id, hook_id, entry, created_by, created_at, status, position)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`).run(projectDir, chatId, hook.id, JSON.stringify(hook), createdBy, Date.now(), position);
  return get(projectDir, chatId, hook.id);
}

// update(projectDir, chatId, hookId, { entry?, status? }) -> the row, or null when absent.
// An edited entry keeps the hook's id.
function update(projectDir, chatId, hookId, { entry, status } = {}) {
  const current = get(projectDir, chatId, hookId);
  if (!current) return null;
  if (status !== undefined && !STATUSES.includes(status)) throw fail('status must be active or paused');
  if (entry !== undefined) {
    const hook = hooksMod().normalizeHook(Object.assign({}, entry, { id: hookId }));
    hook.enabled = true;
    store().prepare('UPDATE chat_hook SET entry = ? WHERE project_dir = ? AND chat_id = ? AND hook_id = ?')
      .run(JSON.stringify(hook), projectDir, chatId, hookId);
  }
  if (status !== undefined) {
    store().prepare('UPDATE chat_hook SET status = ? WHERE project_dir = ? AND chat_id = ? AND hook_id = ?')
      .run(status, projectDir, chatId, hookId);
  }
  return get(projectDir, chatId, hookId);
}

function remove(projectDir, chatId, hookId) {
  return store().prepare('DELETE FROM chat_hook WHERE project_dir = ? AND chat_id = ? AND hook_id = ?')
    .run(projectDir, chatId, hookId).changes > 0;
}

function removeChat(projectDir, chatId) {
  return store().prepare('DELETE FROM chat_hook WHERE project_dir = ? AND chat_id = ?').run(projectDir, chatId).changes;
}

// promote(projectDir, chatId, hookId) -> app hook — moves a chat hook into the
// app's hook list (every chat), at the end, with a free id. The chat copy is
// removed only after the app list saved.
function promote(projectDir, chatId, hookId) {
  const current = get(projectDir, chatId, hookId);
  if (!current) return null;
  const hooks = hooksMod();
  const config = hooks.getConfig();
  const ids = new Set(config.list.map((h) => h.id));
  let id = current.hook.id;
  for (let i = 2; ids.has(id); i++) id = current.hook.id.slice(0, 34) + '-' + i;
  const hook = Object.assign({}, current.hook, { id, enabled: current.status === 'active' });
  hooks.setConfig({ enabled: config.enabled, list: config.list.concat(hook) });
  remove(projectDir, chatId, hookId);
  return hook;
}

// Chat ids with at least one hook, for the chat list.
function chatIds(projectDir) {
  return store().prepare('SELECT DISTINCT chat_id FROM chat_hook WHERE project_dir = ?').all(projectDir).map((r) => r.chat_id);
}

module.exports = { MAX_PER_CHAT, STATUSES, list, active, get, add, update, remove, removeChat, promote, chatIds };
