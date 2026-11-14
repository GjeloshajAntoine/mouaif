'use strict';

// Collections: one implementation of "read the list, change it, write it
// back" for every kind of configured list (agents, prompts, models, custom
// actions, tags, hide-file rules, tool wording sets, …). Feature modules keep
// their own normalising, limits and runtime behaviour and call these for
// storage; the write goes through the content write path, so it gets the
// policy check, a change list and `content_changed`.
//
//   read(type, scope, projectDir)                -> stored items (array or map)
//   list(type, scope, projectDir)                -> [{ id, item }]
//   get(type, scope, projectDir, id)             -> item | null
//   replace(type, scope, projectDir, items, opts) -> { changes, value }
//   put(type, scope, projectDir, item, opts)      -> { changes, value }   (array: by itemId)
//   putAt(type, scope, projectDir, id, item, opts)-> { changes, value }   (map: by key)
//   remove(type, scope, projectDir, id, opts)     -> { changes, value, removed }
//   listMerged(type, projectDir)                  -> [{ id, item, scope }]
//
// `type` is a registry id or declaration. `opts` passes through to the write
// path: { actor, remote, via, dryRun, unset }.

const registry = require('./registry.js');
const service = require('./service.js');
const { isPlainObject } = require('./changes.js');

function typeOf(type) {
  const t = typeof type === 'string' ? registry.getType(type) : type;
  if (!t || t.shape !== 'collection') throw new TypeError('not a collection type: ' + (type && type.id || type));
  return t;
}

function empty(t) {
  return t.container === 'map' ? {} : [];
}

function read(type, scope, projectDir) {
  const t = typeOf(type);
  const value = service.readType(t, scope, projectDir);
  if (t.container === 'map') return isPlainObject(value) ? value : {};
  return Array.isArray(value) ? value : [];
}

function idOf(t, item) {
  return isPlainObject(item) && item[t.itemId] !== undefined && item[t.itemId] !== null ? String(item[t.itemId]) : null;
}

function list(type, scope, projectDir) {
  const t = typeOf(type);
  const items = read(t, scope, projectDir);
  if (t.container === 'map') return Object.keys(items).map((id) => ({ id, item: items[id] }));
  return items.map((item) => ({ id: idOf(t, item), item }));
}

function get(type, scope, projectDir, id) {
  const hit = list(type, scope, projectDir).find((e) => e.id === String(id));
  return hit ? hit.item : null;
}

function replace(type, scope, projectDir, items, opts = {}) {
  const t = typeOf(type);
  return service.writeType({ ...opts, type: t, scope, projectDir, value: items === undefined ? empty(t) : items });
}

// Insert an array item, or replace the item with the same id in place.
function put(type, scope, projectDir, item, opts = {}) {
  const t = typeOf(type);
  if (t.container !== 'array') throw new TypeError(t.id + ' is keyed by map key: use putAt');
  const id = idOf(t, item);
  if (id === null) throw new TypeError(t.id + ' item needs a ' + t.itemId);
  const items = read(t, scope, projectDir).slice();
  const at = items.findIndex((x) => idOf(t, x) === id);
  if (at >= 0) items[at] = item; else items.push(item);
  return replace(t, scope, projectDir, items, opts);
}

// Set a map entry.
function putAt(type, scope, projectDir, id, item, opts = {}) {
  const t = typeOf(type);
  if (t.container !== 'map') throw new TypeError(t.id + ' is a list: use put');
  return replace(t, scope, projectDir, { ...read(t, scope, projectDir), [id]: item }, opts);
}

function remove(type, scope, projectDir, id, opts = {}) {
  const t = typeOf(type);
  const key = String(id);
  const items = read(t, scope, projectDir);
  if (t.container === 'map') {
    if (!Object.prototype.hasOwnProperty.call(items, key)) return { changes: [], value: items, removed: null };
    const next = { ...items };
    const removed = next[key];
    delete next[key];
    return { ...replace(t, scope, projectDir, next, opts), removed };
  }
  const at = items.findIndex((x) => idOf(t, x) === key);
  if (at < 0) return { changes: [], value: items, removed: null };
  const next = items.slice();
  const [removed] = next.splice(at, 1);
  return { ...replace(t, scope, projectDir, next, opts), removed };
}

// Items from both scopes, following the type's merge rule:
//   override  a project item replaces the app item with the same id
//   concat    both lists, each item tagged with its scope
//   replace   the project list replaces the app list when it has any items
function listMerged(type, projectDir) {
  const t = typeOf(type);
  const app = t.scopes.includes('app') ? list(t, 'app').map((e) => ({ ...e, scope: 'app' })) : [];
  const project = projectDir && t.scopes.includes('project')
    ? list(t, 'project', projectDir).map((e) => ({ ...e, scope: 'project' }))
    : [];
  if (t.merge === 'concat') return [...app, ...project];
  if (t.merge === 'replace') return project.length ? project : app;
  const projectIds = new Set(project.map((e) => e.id));
  return [...project, ...app.filter((e) => !projectIds.has(e.id))];
}

module.exports = { read, list, get, replace, put, putAt, remove, listMerged };
