'use strict';

// Extensions (docs/features/extensions.md, spec phase 5).
//
// An extension is ONE JSON file, `<id>.mouaif-extension.json`:
//
//   { "mouaifExtension": 1, "id": "ci-watch", "name": "CI watch", "version": "0.1.0",
//     "description": "…",
//     "server": { "ref": "<configured MCP server id or slug>" } | { inline MCP server },
//     "permissions": ["chat.read", "composer.insert", "chat.message", "storage", "model.context"],
//     "hooks": [ hook entries, as in Settings → Hooks; kind "mcp" calls the server ],
//     "ui": [ { "id", "slot", "title", "resourceUri" | "html", … } ] }
//
// Unknown top-level keys are kept (a newer file imports into an older
// mouaif) and export writes the stored JSON back unchanged plus `exportedAt`.
//
// Where they live:
//   app      the `extension` table, imported from Settings → Extensions; off
//            until the user turns it on after the permission screen. Turning
//            it on registers an inline server (app scope); off or delete
//            removes it.
//   project  `.mouaif/extensions/<id>.mouaif-extension.json` in the repository;
//            inert until the user trusts its hash (hook_trust key `ext:<id>`,
//            the same store as project hooks). A project extension may only
//            reference a server (`server.ref`), never register one.
//   project setting  `.mouaif.json` `extensions: { "<id>": { "enabled": false } }`
//            turns an extension off in that project.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 1;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_FILE = 1024 * 1024;
const MAX_HTML = 512 * 1024;
const MAX_HOOKS = 50;
const MAX_UI = 20;
const PROJECT_DIR = path.join('.mouaif', 'extensions');
const SUFFIX = '.mouaif-extension.json';

// What each permission lets a surface do (shown on the permission screen).
const PERMISSIONS = Object.freeze({
  'chat.read': 'Read the chat’s recent messages (text only)',
  'composer.insert': 'Put text in your message box (it never sends it)',
  'chat.message': 'Send a message in the chat',
  storage: 'Keep its own small settings (64 KB)',
  'model.context': 'Add context the model sees on the next turns'
});
const SLOTS = Object.freeze(['chat.dock', 'chat.sheet', 'settings.page', 'tool.renderer', 'project.card']);
// Slots that live in a chat (a mount needs a chat id).
const CHAT_SLOTS = Object.freeze(['chat.dock', 'chat.sheet', 'tool.renderer']);
const UI_EVENTS = Object.freeze(['turn.start', 'turn.end', 'tool.after']);
const SERVER_KEYS = Object.freeze(['name', 'command', 'args', 'env', 'cwd', 'url', 'transport', 'headers']);

function hooksMod() { return require('./hooks.js'); }
function fail(message, status = 400) { return new (hooksMod().HookError)(message, status); }

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function str(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fail(field + ' is required');
    return '';
  }
  if (typeof value !== 'string') throw fail(field + ' must be a string');
  if (Buffer.byteLength(value) > max) throw fail(field + ' is longer than ' + max + ' bytes');
  return value;
}

function normalizeServer(raw, scope) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw fail('server must be an object');
  if (raw.ref !== undefined) {
    const ref = str(raw.ref, 'server.ref', 128, { required: true }).trim();
    return { ref };
  }
  if (scope === 'project') throw fail('a project extension can only reference a server (server.ref); add the server to the project’s .mcp.json');
  const name = str(raw.name, 'server.name', 80, { required: true }).trim();
  const out = { name };
  for (const key of SERVER_KEYS) {
    if (key === 'name' || raw[key] === undefined) continue;
    out[key] = raw[key];
  }
  if (!out.command && !out.url) throw fail('server needs a command (stdio) or a url (http)');
  if (out.command !== undefined && typeof out.command !== 'string') throw fail('server.command must be a string');
  if (out.url !== undefined && typeof out.url !== 'string') throw fail('server.url must be a string');
  if (out.args !== undefined && !(Array.isArray(out.args) && out.args.every((a) => typeof a === 'string'))) throw fail('server.args must be a list of strings');
  if (out.env !== undefined && !(isObject(out.env) && Object.values(out.env).every((v) => typeof v === 'string'))) throw fail('server.env must map names to strings');
  return out;
}

function normalizeUi(raw, hasServer) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw fail('ui must be a list');
  if (raw.length > MAX_UI) throw fail('at most ' + MAX_UI + ' ui surfaces');
  const seen = new Set();
  return raw.map((u, i) => {
    const at = 'ui[' + i + ']';
    if (!isObject(u)) throw fail(at + ' must be an object');
    const id = str(u.id, at + '.id', 40, { required: true });
    if (!ID_RE.test(id)) throw fail(at + '.id must be lowercase letters, digits and - (max 40)');
    if (seen.has(id)) throw fail('ui id "' + id + '" is used twice');
    seen.add(id);
    if (!SLOTS.includes(u.slot)) throw fail(at + '.slot must be one of ' + SLOTS.join(', '));
    const title = str(u.title, at + '.title', 60, { required: true }).trim();
    const out = { id, slot: u.slot, title };
    const resourceUri = str(u.resourceUri, at + '.resourceUri', 512).trim();
    const html = str(u.html, at + '.html', MAX_HTML);
    if (!!resourceUri === !!html) throw fail(at + ' needs resourceUri or html (not both)');
    if (resourceUri) {
      if (!resourceUri.startsWith('ui://')) throw fail(at + '.resourceUri must be a ui:// resource');
      if (!hasServer) throw fail(at + '.resourceUri needs the extension’s server');
      out.resourceUri = resourceUri;
    } else out.html = html;
    if (u.collapsed !== undefined) {
      if (u.collapsed !== 'chip' && u.collapsed !== 'open') throw fail(at + '.collapsed must be chip or open');
      out.collapsed = u.collapsed;
    }
    if (u.events !== undefined) {
      if (!Array.isArray(u.events) || !u.events.every((e) => UI_EVENTS.includes(e))) throw fail(at + '.events must be among ' + UI_EVENTS.join(', '));
      out.events = [...new Set(u.events)];
    }
    if (u.slot === 'tool.renderer') {
      const tools = u.match && Array.isArray(u.match.tool) ? u.match.tool : null;
      if (!tools || !tools.length || !tools.every((t) => typeof t === 'string' && /^[A-Za-z0-9_*.-]{1,128}$/.test(t))) {
        throw fail(at + '.match.tool (tool names, * for any) is required for a tool.renderer');
      }
      out.match = { tool: tools };
    }
    return out;
  });
}

// validate(raw, { scope }) -> ext (normalized view). The raw object is what
// is stored and exported; this view is what mouaif runs.
function validate(raw, { scope = 'app' } = {}) {
  if (!isObject(raw)) throw fail('an extension file is a JSON object');
  if (raw.mouaifExtension !== FORMAT) throw fail('not a mouaif extension (mouaifExtension must be ' + FORMAT + ')');
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_FILE) throw fail('an extension file is at most 1 MiB');
  const id = str(raw.id, 'id', 40, { required: true });
  if (!ID_RE.test(id)) throw fail('id must be lowercase letters, digits and - (max 40)');
  const ext = {
    id,
    name: str(raw.name, 'name', 80, { required: true }).trim(),
    version: str(raw.version, 'version', 40).trim(),
    description: str(raw.description, 'description', 500).trim()
  };
  ext.server = normalizeServer(raw.server, scope);
  const perms = raw.permissions === undefined ? [] : raw.permissions;
  if (!Array.isArray(perms) || !perms.every((p) => Object.prototype.hasOwnProperty.call(PERMISSIONS, p))) {
    throw fail('permissions must be among ' + Object.keys(PERMISSIONS).join(', '));
  }
  ext.permissions = [...new Set(perms)];
  const hooks = raw.hooks === undefined ? [] : raw.hooks;
  if (!Array.isArray(hooks)) throw fail('hooks must be a list');
  if (hooks.length > MAX_HOOKS) throw fail('at most ' + MAX_HOOKS + ' hooks');
  const seen = new Set();
  ext.hooks = hooks.map((h, i) => {
    const hook = hooksMod().normalizeHook(h, i, { inExtension: true });
    if (seen.has(hook.id)) throw fail('hook id "' + hook.id + '" is used twice');
    seen.add(hook.id);
    if (hook.handler.kind === 'mcp' && !ext.server) throw fail('hooks[' + i + '] is an mcp hook but the extension has no server');
    return hook;
  });
  ext.ui = normalizeUi(raw.ui, !!ext.server);
  return ext;
}

// ---- App store ---------------------------------------------------------------

const CREATE = `
  CREATE TABLE IF NOT EXISTS extension (
    id          TEXT PRIMARY KEY,
    manifest    TEXT NOT NULL,
    enabled     INTEGER NOT NULL,
    imported_at INTEGER NOT NULL,
    server_id   TEXT,
    position    INTEGER NOT NULL
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

function appRows() {
  try { return store().prepare('SELECT * FROM extension ORDER BY position, imported_at').all(); }
  catch { return []; }
}

function appRow(id) {
  return store().prepare('SELECT * FROM extension WHERE id = ?').get(id) || null;
}

function parseRow(row) {
  let raw = null;
  let ext = null;
  let error = null;
  try { raw = JSON.parse(row.manifest); ext = validate(raw, { scope: 'app' }); }
  catch (e) { error = e.message; }
  return { row, raw, ext, error };
}

// The permission screen: what turning the extension on allows, in words.
function summary(ext) {
  return {
    permissions: ext.permissions.map((p) => ({ id: p, text: PERMISSIONS[p] })),
    server: ext.server ? (ext.server.ref ? { ref: ext.server.ref } : { registers: ext.server.name, command: ext.server.command || null, url: ext.server.url || null, args: ext.server.args || [] }) : null,
    hooks: ext.hooks,
    ui: ext.ui.map((u) => ({ id: u.id, slot: u.slot, title: u.title, source: u.resourceUri || 'inline html' }))
  };
}

// importApp(raw) -> { extension, summary } — stored OFF: the user turns it on
// after reading the permission screen. Re-importing an id replaces it and
// turns it off again (its new content needs a new look).
function importApp(raw) {
  clearCache();
  const ext = validate(raw, { scope: 'app' });
  const existing = appRow(ext.id);
  if (existing) unregisterServer(existing);
  const position = existing ? existing.position : appRows().reduce((m, r) => Math.max(m, r.position), -1) + 1;
  store().prepare(`INSERT INTO extension (id, manifest, enabled, imported_at, server_id, position) VALUES (?, ?, 0, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, enabled = 0, imported_at = excluded.imported_at, server_id = NULL`)
    .run(ext.id, JSON.stringify(raw), Date.now(), position);
  return { extension: viewApp(appRow(ext.id)), summary: summary(ext), replaced: !!existing };
}

function registerServer(row, ext) {
  if (!ext.server || ext.server.ref || row.server_id) return row.server_id || null;
  const mcp = require('./mcp.js');
  const entry = mcp.addServer(null, Object.assign({}, ext.server, { scope: mcp.APP_SCOPE }));
  store().prepare('UPDATE extension SET server_id = ? WHERE id = ?').run(entry.id, row.id);
  return entry.id;
}

function unregisterServer(row) {
  if (!row || !row.server_id) return;
  try { require('./mcp.js').removeServer(null, row.server_id); } catch { /* already gone */ }
  try { store().prepare('UPDATE extension SET server_id = NULL WHERE id = ?').run(row.id); } catch { /* row gone */ }
}

function setAppEnabled(id, enabled) {
  clearCache();
  const row = appRow(id);
  if (!row) return null;
  const { ext, error } = parseRow(row);
  if (enabled && !ext) throw fail('this extension no longer validates: ' + error, 409);
  if (enabled) registerServer(row, ext);
  else unregisterServer(row);
  store().prepare('UPDATE extension SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return viewApp(appRow(id));
}

function removeApp(id) {
  clearCache();
  const row = appRow(id);
  if (!row) return false;
  unregisterServer(row);
  store().prepare('DELETE FROM extension WHERE id = ?').run(id);
  return true;
}

function exportApp(id) {
  const row = appRow(id);
  if (!row) return null;
  return Object.assign(JSON.parse(row.manifest), { exportedAt: new Date().toISOString() });
}

function viewApp(row, projectDir) {
  const { raw, ext, error } = parseRow(row);
  const off = projectDir ? projectOff(projectDir) : new Set();
  const view = {
    id: row.id, scope: 'app', enabled: row.enabled === 1, importedAt: row.imported_at,
    name: ext ? ext.name : (raw && raw.name) || row.id
  };
  if (ext) Object.assign(view, { version: ext.version, description: ext.description, summary: summary(ext) });
  if (error) view.error = error;
  if (projectDir) {
    view.offInProject = off.has(row.id);
    view.active = view.enabled && !view.offInProject && !error;
  }
  return view;
}

// ---- Project files -------------------------------------------------------------

function projectOff(projectDir) {
  try {
    const map = require('./settings.js').getProject(projectDir).extensions;
    if (!isObject(map)) return new Set();
    return new Set(Object.entries(map).filter(([, v]) => isObject(v) && v.enabled === false).map(([k]) => k));
  } catch { return new Set(); }
}

// setProjectOff(projectDir, id, off) — the per-project switch, in the
// project's settings (`extensions: { id: { enabled: false } }`).
function setProjectOff(projectDir, id, off) {
  clearCache();
  const settings = require('./settings.js');
  const current = settings.getProject(projectDir).extensions;
  const next = Object.assign({}, isObject(current) ? current : {});
  if (off) next[id] = { enabled: false };
  else delete next[id];
  settings.setProject(projectDir, { extensions: next });
}

// projectFiles(projectDir) -> [{ id, file, raw?, ext?, error?, hash, trusted, changed }]
function projectFiles(projectDir) {
  if (!projectDir) return [];
  const dir = path.join(projectDir, PROJECT_DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(SUFFIX)).sort(); } catch { return []; }
  const projectHooks = require('./projectHooks.js');
  const out = [];
  for (const name of names.slice(0, 50)) {
    const file = path.join(PROJECT_DIR, name);
    const item = { id: name.slice(0, -SUFFIX.length), file };
    let text = '';
    try {
      const stat = fs.statSync(path.join(projectDir, file));
      if (stat.size > MAX_FILE) throw new Error('larger than 1 MiB');
      text = fs.readFileSync(path.join(projectDir, file), 'utf8');
      item.raw = JSON.parse(text);
      item.ext = validate(item.raw, { scope: 'project' });
      if (item.ext.id !== item.id) throw new Error('its id "' + item.ext.id + '" does not match the file name');
    } catch (e) { item.error = e.message; delete item.ext; }
    // The hash covers the file and every project script its command hooks run.
    const h = crypto.createHash('sha256');
    h.update('extension\n' + (item.raw ? projectHooks.canonical(item.raw) : text) + '\n');
    const files = [];
    for (const hook of (item.ext ? item.ext.hooks : [])) {
      if (hook.handler.kind !== 'command' || !hook.handler.command) continue;
      for (const rel of projectHooks.referencedFiles(projectDir, hook.handler.command)) if (!files.includes(rel)) files.push(rel);
    }
    for (const rel of files.slice(0, 20)) {
      try { h.update('file ' + rel + '\n'); h.update(fs.readFileSync(path.join(projectDir, rel))); h.update('\n'); }
      catch { h.update('missing ' + rel + '\n'); }
    }
    item.files = files;
    item.hash = h.digest('hex');
    const trusted = projectHooks.trustedHash(projectDir, 'ext:' + item.id);
    item.trusted = !!trusted && trusted === item.hash && !item.error;
    item.changed = !!trusted && trusted !== item.hash;
    out.push(item);
  }
  return out;
}

function trustProject(projectDir, id, hash) {
  clearCache();
  const item = projectFiles(projectDir).find((x) => x.id === id);
  if (!item) throw fail('this project has no extension "' + id + '"', 404);
  if (item.error) throw fail('this extension does not validate: ' + item.error, 409);
  if (item.hash !== hash) throw fail('the extension changed since you reviewed it; review it again', 409);
  require('./projectHooks.js').setTrust(projectDir, hash, 'ext:' + id);
  return viewProject(projectFiles(projectDir).find((x) => x.id === id), projectDir);
}

function revokeProject(projectDir, id) {
  clearCache();
  require('./projectHooks.js').revoke(projectDir, 'ext:' + id);
}

function viewProject(item, projectDir) {
  const off = projectOff(projectDir);
  const view = { id: item.id, scope: 'project', file: item.file, hash: item.hash, trusted: item.trusted, changed: item.changed,
    name: item.ext ? item.ext.name : (item.raw && item.raw.name) || item.id, offInProject: off.has(item.id) };
  if (item.ext) Object.assign(view, { version: item.ext.version, description: item.ext.description, summary: summary(item.ext), files: item.files });
  if (item.error) view.error = item.error;
  view.active = view.trusted && !view.offInProject;
  return view;
}

// list(projectDir) -> every extension visible here: app ones (with the
// project switch) then the project's files (with their trust state).
function list(projectDir) {
  const app = appRows().map((row) => viewApp(row, projectDir));
  const project = projectDir ? projectFiles(projectDir).map((item) => viewProject(item, projectDir)) : [];
  return { app, project };
}

// ---- What runs -------------------------------------------------------------------

function serverSlug(projectDir, ext, row) {
  if (!ext.server) return null;
  const wanted = ext.server.ref || (row && row.server_id);
  if (!wanted) return null;
  try {
    const found = require('./mcp.js').listServers(projectDir || null).find((s) => s.id === wanted || s.slug === wanted);
    return found ? found.slug : (ext.server.ref || null);
  } catch { return ext.server.ref || null; }
}

// active(projectDir) -> [{ ext, scope, serverSlug }] — enabled app extensions
// not switched off here, then trusted project extensions not switched off.
// A project file shadows an app extension with the same id.
function active(projectDir) {
  const off = projectDir ? projectOff(projectDir) : new Set();
  const out = [];
  const project = projectDir ? projectFiles(projectDir) : [];
  const projectIds = new Set(project.map((x) => x.id));
  for (const row of appRows()) {
    if (row.enabled !== 1 || off.has(row.id) || projectIds.has(row.id)) continue;
    const { ext } = parseRow(row);
    if (ext) out.push({ ext, scope: 'app', serverSlug: serverSlug(projectDir, ext, row) });
  }
  for (const item of project) {
    if (!item.trusted || !item.ext || off.has(item.id)) continue;
    out.push({ ext: item.ext, scope: 'project', serverSlug: serverSlug(projectDir, item.ext, null) });
  }
  return out;
}

// Small per-project cache: hooks run on every tool call.
const cache = new Map();
const CACHE_MS = 2000;

// runtimeHooks(projectDir) -> { app: [hook], project: [hook] } with ids
// `<extension>/<hook>`, `extension` set, and mcp hooks bound to the server.
function runtimeHooks(projectDir) {
  const key = projectDir || '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = { app: [], project: [] };
  for (const { ext, scope, serverSlug: slug } of active(projectDir)) {
    for (const hook of ext.hooks) {
      const h = Object.assign({}, hook, { id: ext.id + '/' + hook.id, extension: ext.id });
      if (scope === 'project') h.scope = 'project';
      if (h.handler.kind === 'mcp') h.handler = Object.assign({}, h.handler, { server: slug || '' });
      value[scope].push(h);
    }
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

function clearCache() { cache.clear(); }

// surface(projectDir, extensionId, surfaceId) -> { ext, scope, serverSlug, ui } | null
// Only an ACTIVE extension's surface resolves (phase 6 mounts use this).
function surface(projectDir, extensionId, surfaceId) {
  const found = active(projectDir).find((a) => a.ext.id === extensionId);
  if (!found) return null;
  const ui = found.ext.ui.find((u) => u.id === surfaceId);
  return ui ? Object.assign({}, found, { ui }) : null;
}

module.exports = {
  FORMAT, PERMISSIONS, SLOTS, CHAT_SLOTS, UI_EVENTS, SUFFIX, PROJECT_DIR,
  validate, summary, importApp, setAppEnabled, removeApp, exportApp, setProjectOff,
  projectFiles, trustProject, revokeProject, list, active, runtimeHooks, surface, clearCache
};
