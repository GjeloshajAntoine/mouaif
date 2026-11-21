'use strict';

// One-time storage migration only. The live tool paths use ordinary names.
const { DEFINITIONS, LEGACY_DEFINITIONS } = require('./tools/appToolNames.js');
// Live tools plus the retired shapes, so an old `mouaif:working_folder`
// permission row still maps onto `change_working_folder` — see
// LEGACY_DEFINITIONS in appToolNames.js.
const MIGRATABLE = { ...LEGACY_DEFINITIONS, ...DEFINITIONS };
const MIGRATABLE_NAMES = Object.keys(MIGRATABLE);
const TOOL_NAMES = Object.keys(DEFINITIONS);
const ACTION_TO_NAME = Object.fromEntries(MIGRATABLE_NAMES.map((name) => [MIGRATABLE[name].action, name]));

function selection(value) {
  if (!Array.isArray(value)) return value;
  return [...new Set(value.flatMap((name) => {
    if (name === 'mouaif') return TOOL_NAMES;
    if (typeof name === 'string' && name.startsWith('mouaif:')) return ACTION_TO_NAME[name.slice(7)] || name;
    return name;
  }))];
}

function permissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const next = { ...value };
  const family = value.mouaif;
  for (const name of MIGRATABLE_NAMES) {
    const key = 'mouaif:' + MIGRATABLE[name].action;
    const legacy = family?.mode === 'off' ? family : (value[key] || family);
    if (legacy && !Object.prototype.hasOwnProperty.call(next, name)) next[name] = { ...legacy };
    delete next[key];
  }
  delete next.mouaif;
  return next;
}

// walk(value, transform): apply `transform.selection` to every stored tool
// selection and `transform.permissions` to every stored permission map in a
// settings, preset, agent or chat object.
function walk(value, transform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const next = { ...value };
  if (Array.isArray(value.tools)) next.tools = transform.selection(value.tools);
  else if (value.tools) next.tools = transform.permissions(value.tools);
  if (value.toolAuth) {
    const raw = value.toolAuth;
    next.toolAuth = raw.native ? { ...raw, native: transform.permissions(raw.native) } : transform.permissions(raw);
  }
  if (value.preset) next.preset = walk(value.preset, transform);
  if (value.promptSnapshot) next.promptSnapshot = walk(value.promptSnapshot, transform);
  if (value.defaultAgent) next.defaultAgent = walk(value.defaultAgent, transform);
  if (Array.isArray(value.agents)) next.agents = value.agents.map((entry) => walk(entry, transform));
  if (Array.isArray(value.prompts)) next.prompts = value.prompts.map((entry) => walk(entry, transform));
  return next;
}

function config(value) {
  return walk(value, { selection, permissions });
}

// renameTool(from, to) -> converter: stored selections name `to` instead of
// `from`, and a permission row for `from` moves to `to` unless `to` has one.
function renameTool(from, to) {
  const transform = {
    selection: (value) => (Array.isArray(value) && value.includes(from)
      ? [...new Set(value.map((name) => (name === from ? to : name)))] : value),
    permissions: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, from)) return value;
      const next = { ...value };
      if (!Object.prototype.hasOwnProperty.call(next, to)) next[to] = next[from];
      delete next[from];
      return next;
    }
  };
  return (value) => walk(value, transform);
}

function run(convert = config) {
  const settings = require('./settings.js');
  require('./chatdb.js').ensureChatTables();
  const db = settings.getDb();
  const stores = require('./content/stores/index.js');
  const app = settings.updateApp((current) => {
    const next = convert(current);
    return JSON.stringify(next) === JSON.stringify(current) ? current : next;
  });
  const projects = Array.isArray(app.projects) ? app.projects : [];
  const dirs = new Set(projects.map((project) => project?.path).filter(Boolean));
  for (const row of db.prepare('SELECT DISTINCT project_dir FROM chat_store UNION SELECT project_dir FROM project_settings').all()) dirs.add(row.project_dir);
  let complete = true;
  for (const dir of dirs) {
    try {
      stores.withWriteLock(() => {
        const current = settings.getProject(dir);
        const next = convert(current);
        if (JSON.stringify(next) !== JSON.stringify(current)) settings.setProject(dir, next);
      });
    } catch (e) {
      // Leave the original intact and retry on the next startup. A broken
      // project must not block the remaining projects, chats or migrations.
      complete = false;
      console.warn('[migration] tool settings deferred for ' + dir + ': ' + e.message);
    }
  }
  const update = db.prepare('UPDATE chat_store SET tools = ?, tool_auth = ?, prompt_snapshot = ? WHERE project_dir = ? AND id = ?');
  stores.withWriteLock(() => {
    const rows = db.prepare('SELECT project_dir, id, tools, tool_auth, prompt_snapshot FROM chat_store').all();
    for (const row of rows) {
      const current = { tools: row.tools ? JSON.parse(row.tools) : null,
        toolAuth: row.tool_auth ? JSON.parse(row.tool_auth) : null,
        promptSnapshot: row.prompt_snapshot ? JSON.parse(row.prompt_snapshot) : null };
      const next = convert(current);
      if (JSON.stringify(next) === JSON.stringify(current)) continue;
      update.run(next.tools === null ? null : JSON.stringify(next.tools), next.toolAuth === null ? null : JSON.stringify(next.toolAuth),
        next.promptSnapshot === null ? null : JSON.stringify(next.promptSnapshot), row.project_dir, row.id);
    }
  });
  return complete;
}

module.exports = { config, renameTool, run };
