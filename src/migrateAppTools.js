'use strict';

// One-time storage migration only. The live tool paths use ordinary names.
const { DEFINITIONS, TOOL_NAMES } = require('./tools/appToolNames.js');
const ACTION_TO_NAME = Object.fromEntries(TOOL_NAMES.map((name) => [DEFINITIONS[name].action, name]));

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
  for (const name of TOOL_NAMES) {
    const key = 'mouaif:' + DEFINITIONS[name].action;
    const legacy = family?.mode === 'off' ? family : (value[key] || family);
    if (legacy && !Object.prototype.hasOwnProperty.call(next, name)) next[name] = { ...legacy };
    delete next[key];
  }
  delete next.mouaif;
  return next;
}

function config(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const next = { ...value };
  if (Array.isArray(value.tools)) next.tools = selection(value.tools);
  else if (value.tools) next.tools = permissions(value.tools);
  if (value.toolAuth) {
    const raw = value.toolAuth;
    next.toolAuth = raw.native ? { ...raw, native: permissions(raw.native) } : permissions(raw);
  }
  if (value.preset) next.preset = config(value.preset);
  if (value.promptSnapshot) next.promptSnapshot = config(value.promptSnapshot);
  if (value.defaultAgent) next.defaultAgent = config(value.defaultAgent);
  if (Array.isArray(value.agents)) next.agents = value.agents.map(config);
  if (Array.isArray(value.prompts)) next.prompts = value.prompts.map(config);
  return next;
}

function run() {
  const settings = require('./settings.js');
  require('./chatdb.js').ensureChatTables();
  const db = settings.getDb();
  const app = settings.getApp();
  const converted = config(app);
  if (JSON.stringify(converted) !== JSON.stringify(app)) settings.setAppReplace(converted);
  const dirs = new Set((app.projects || []).map((project) => project.path).filter(Boolean));
  for (const row of db.prepare('SELECT DISTINCT project_dir FROM chat_store UNION SELECT project_dir FROM project_settings').all()) dirs.add(row.project_dir);
  for (const dir of dirs) {
    // An inaccessible project must leave this migration retryable, not mark
    // old permissions as migrated and silently reset them to Ask later.
    const current = settings.getProject(dir);
    const next = config(current);
    if (JSON.stringify(next) !== JSON.stringify(current)) settings.setProject(dir, next);
  }
  const rows = db.prepare('SELECT project_dir, id, tools, tool_auth, prompt_snapshot FROM chat_store').all();
  const update = db.prepare('UPDATE chat_store SET tools = ?, tool_auth = ?, prompt_snapshot = ? WHERE project_dir = ? AND id = ?');
  db.transaction(() => {
    for (const row of rows) {
      const current = { tools: row.tools ? JSON.parse(row.tools) : null,
        toolAuth: row.tool_auth ? JSON.parse(row.tool_auth) : null,
        promptSnapshot: row.prompt_snapshot ? JSON.parse(row.prompt_snapshot) : null };
      const next = config(current);
      if (JSON.stringify(next) === JSON.stringify(current)) continue;
      update.run(next.tools === null ? null : JSON.stringify(next.tools), next.toolAuth === null ? null : JSON.stringify(next.toolAuth),
        next.promptSnapshot === null ? null : JSON.stringify(next.promptSnapshot), row.project_dir, row.id);
    }
  })();
}

module.exports = { config, run };
