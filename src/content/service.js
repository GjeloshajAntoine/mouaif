'use strict';

// The one write path for configured content. The settings routes, the
// update_settings tool and a shared project's remote caller all change the
// settings document through applyPatch(); their differences live in the
// policy table (src/content/policy.js).
//
//   applyPatch({ scope, projectDir, patch, unset, actor, remote, dryRun })
//     -> { changes, warnings, approval, document }
//
// Steps:
//   1. every touched top-level key passes the policy (unknown app keys are
//      refused; unknown project keys pass through: `.mouaif.json` stays
//      open-ended)
//   2. secrets: refused from the model and remote callers; an entry sent back
//      without its secret keeps the stored one, and loses it when the field
//      the secret is bound to changed (a provider's baseUrl)
//   3. declared values are checked against their field type
//   4. the change list is computed (src/content/changes.js); a dry run stops
//   5. one write per document, then `content_changed` is published

const { EventEmitter } = require('events');
const registry = require('./registry.js');
const policy = require('./policy.js');
const { diffKey, collectionChanges, valueChange, isPlainObject, same } = require('./changes.js');
const stores = require('./stores/index.js');
const { clone } = require('./stores/cache.js');

const events = new EventEmitter();
events.setMaxListeners(50);

// ---- Secrets -------------------------------------------------------------

// Response-only markers (`hasApiKey`) are dropped; a stored secret is carried
// over to an entry re-sent without it, unless the field it is bound to (the
// URL it is sent to) changed — that would send the stored key to a host the
// user never entered it for.
function carrySecrets(type, entries, existing) {
  if (!Array.isArray(entries)) return entries;
  const secrets = policy.secretFields(type);
  if (!secrets.length) return entries;
  const prior = Array.isArray(existing) ? existing : [];
  return entries.map((entry) => {
    if (!isPlainObject(entry)) return entry;
    const clean = { ...entry };
    for (const field of secrets) {
      delete clean['has' + field[0].toUpperCase() + field.slice(1)];
      if (Object.prototype.hasOwnProperty.call(clean, field)) continue;
      const prev = prior.find((x) => x && x[type.itemId] === clean[type.itemId]);
      if (!prev || typeof prev[field] !== 'string') continue;
      const bound = type.fields[field].boundTo;
      if (bound) {
        const before = typeof prev[bound] === 'string' ? prev[bound].trim() : '';
        const after = typeof clean[bound] === 'string' ? clean[bound].trim() : '';
        if (before !== after) continue;
      }
      clean[field] = prev[field];
    }
    return clean;
  });
}

function prepareValue(key, value, existing) {
  for (const type of registry.typesForRoot(key)) {
    if (type.shape === 'collection' && type.path === key && type.container === 'array') {
      value = carrySecrets(type, value, existing);
    }
  }
  return value;
}

// ---- Field checks --------------------------------------------------------

function typeError(path, expected) {
  return policy.refusal(path + ' must be ' + expected);
}

// checkField(path, field, value) — throws when a declared value has the wrong
// type. `null` clears a value and is always accepted, as it was before.
function checkField(path, field, value) {
  if (value === undefined || value === null || !field) return;
  switch (field.type) {
    case 'enum':
      if (!field.options.includes(value)) throw typeError(path, 'one of ' + field.options.join(', '));
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw typeError(path, 'true or false');
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw typeError(path, 'a number');
      return;
    case 'integer': {
      const { min, max } = field;
      const inRange = Number.isInteger(value) && (min === undefined || value >= min) && (max === undefined || value <= max);
      if (!inRange) {
        throw typeError(path, min !== undefined && max !== undefined ? 'a whole number from ' + min + ' to ' + max
          : min !== undefined ? 'a whole number of at least ' + min : 'a whole number');
      }
      return;
    }
    case 'string':
    case 'text':
      if (typeof value !== 'string') throw typeError(path, 'a string');
      return;
    case 'list':
      if (!Array.isArray(value)) throw typeError(path, 'a list');
      return;
    case 'object':
      if (!isPlainObject(value)) throw typeError(path, 'an object');
      return;
    default:
  }
}

function validateKey(key, value, scope) {
  if (value === undefined) return;
  for (const type of registry.typesForRoot(key)) {
    if (!type.scopes.includes(scope)) continue;
    const rest = type.path.split('.').slice(1);
    let v = value;
    for (const p of rest) v = isPlainObject(v) ? v[p] : undefined;
    if (rest.length && value !== null && !isPlainObject(value)) throw typeError(key, 'an object');
    if (type.shape === 'value') checkField(type.path, type.field, v);
    else if (v !== undefined && v !== null) {
      if (type.container === 'array' && !Array.isArray(v)) throw typeError(type.path, 'a list');
      if (type.container === 'map' && !isPlainObject(v)) throw typeError(type.path, 'an object');
    }
  }
}

// Stored values that no longer pass the field checks (a hand edit). Reads
// keep using them; the warning lets a page mark the row.
function warningsFor(document, scope) {
  const out = [];
  if (!isPlainObject(document)) return out;
  for (const key of Object.keys(document)) {
    try { validateKey(key, document[key], scope); }
    catch (e) { out.push({ type: (registry.typeForPath(key) || {}).id || key, key, message: e.message }); }
  }
  return out;
}

// ---- Apply ---------------------------------------------------------------

function applyPatch({ scope, projectDir, patch, unset, actor = 'ui', remote = false, dryRun = false } = {}) {
  if (scope !== 'app' && scope !== 'project') throw policy.refusal('scope must be "app" or "project"');
  if (scope === 'project' && (!projectDir || typeof projectDir !== 'string')) {
    throw policy.refusal('projectDir is required');
  }
  const body = isPlainObject(patch) ? patch : {};
  const removing = Array.isArray(unset) ? unset.filter((k) => typeof k === 'string' && k) : [];
  const keys = [];
  for (const k of [...Object.keys(body), ...removing]) if (!keys.includes(k)) keys.push(k);

  let approval = false;
  for (const key of keys) {
    if (key === '__dbBacked') throw policy.refusal('__dbBacked is internal: switch storage with the storage toggle');
    if (policy.checkKey({ key, scope, actor, remote }).approval) approval = true;
  }
  policy.checkSecrets(body, { actor, remote });

  function apply() {
    const store = stores.storeFor('settings', scope, projectDir);
    const current = store.read();
    const next = { ...current };
    for (const key of Object.keys(body)) {
      const value = prepareValue(key, clone(body[key]), current[key]);
      // Only validate changed values; an unchanged hand edit doesn't block a save.
      if (!same(value, current[key])) validateKey(key, value, scope);
      next[key] = value;
    }
    for (const key of removing) delete next[key];

    const changes = [];
    for (const key of keys) changes.push(...diffKey(key, current[key], next[key], { scope }));
    const document = dryRun || !keys.length ? next : store.write(next);
    return { changes, warnings: [], approval, document };
  }
  if (dryRun || !keys.length) return apply();
  const result = stores.withWriteLock(apply);
  events.emit('content_changed', {
    scope,
    projectDir: scope === 'project' ? projectDir : null,
    keys,
    types: [...new Set(result.changes.map((c) => c.type))],
    actor: remote ? 'share' : actor
  });
  return result;
}

// ---- One declared type -----------------------------------------------------

function getAt(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

// The document with `value` at `parts` (undefined removes it). Parents are
// copied, never mutated.
function setAt(obj, parts, value) {
  const out = { ...(isPlainObject(obj) ? obj : {}) };
  const [head, ...rest] = parts;
  if (rest.length) out[head] = setAt(out[head], rest, value);
  else if (value === undefined) delete out[head];
  else out[head] = value;
  return out;
}

// readType(type, scope, projectDir) -> the stored value at the type's path
// (undefined when absent).
function readType(type, scope, projectDir) {
  const store = stores.storeFor(type.doc === 'settings' ? 'settings' : type.doc, scope, projectDir);
  return getAt(store.read(), type.path.split('.'));
}

// ---- Write hooks -----------------------------------------------------------
//
// A type that must react to its own writes registers here (the registry
// stays plain data). beforeWrite(ctx) runs before the document is written and
// its return value is handed to afterWrite(ctx, state) after commit, or to
// afterWriteLocked(ctx, state) if it must observe this exact write:
//   project hooks  carry trust forward while the settings lock is held
// ctx = { type, scope, projectDir, before, after, actor, via }

const writeHooks = new Map();

// A write made while serving a shared project's remote caller (the share gate
// runs the request inside the caller's context).
function isRemoteCall() {
  try { return !!require('../share-gate.js').currentCaller(); } catch { return false; }
}
function onWrite(typeId, hooks) {
  writeHooks.set(typeId, hooks);
}

// checkWrite({ type, scope, actor, remote, via }) -> { approval } or throws.
// The policy check writeType runs, on its own: a feature module with side
// effects outside the document (stopping a process, storing a credential)
// calls it before them, so a refused write leaves nothing behind.
function checkWrite({ type, scope, actor = 'ui', remote, via = null }) {
  if (remote === undefined) remote = isRemoteCall();
  const resolved = typeof type === 'string' ? registry.getType(type) : type;
  if (!resolved) throw policy.refusal('unknown content type: ' + type);
  return policy.checkType({ type: resolved, scope, actor, remote, via });
}

// writeType({ type, scope, projectDir, value, unset, actor, remote, via, dryRun })
//   -> { changes, value, approval }
// Writes one declared type's whole value (a collection's items) in one
// document write. Feature modules normalise before calling; this applies the
// policy, computes the change list and publishes content_changed. `unset`
// names extra top-level keys to drop in the same write (a legacy key the new
// value replaces).
function writeType(opts) {
  const r = writeMany({ ...opts, entries: [{ type: opts.type, value: opts.value }] });
  return { changes: r.changes, value: opts.value, approval: r.approval };
}

// writeMany({ scope, projectDir, entries: [{ type, value }], unset, actor,
//   remote, via, dryRun }) -> { changes, approval }
// Several declared types of one document in one write (a theme list and the
// active theme; the app hook list and its on/off switch).
function writeMany({ scope, projectDir, entries, unset = [], actor = 'ui', remote, via = null, dryRun = false }) {
  if (remote === undefined) remote = isRemoteCall();
  if (scope === 'project' && (!projectDir || typeof projectDir !== 'string')) throw policy.refusal('projectDir is required');
  const resolved = entries.map((e) => {
    const type = typeof e.type === 'string' ? registry.getType(e.type) : e.type;
    if (!type) throw policy.refusal('unknown content type: ' + e.type);
    return { type, value: e.value };
  });
  const docs = new Set(resolved.map((e) => e.type.doc));
  if (docs.size !== 1) throw policy.refusal('writeMany writes one document');
  let approval = false;
  for (const { type } of resolved) {
    if (policy.checkType({ type, scope, actor, remote, via }).approval) approval = true;
  }
  function apply() {
    const store = stores.storeFor([...docs][0], scope, projectDir);
    const current = store.read();
    let next = current;
    const changes = [];
    const touched = [];
    for (const { type, value } of resolved) {
    const parts = type.path.split('.');
    const before = getAt(current, parts);
      next = setAt(next, parts, value === undefined ? undefined : clone(value));
      if (type.shape === 'collection') changes.push(...collectionChanges(type, scope, before, value));
      else if (!same(before, value)) changes.push(valueChange(type, scope, type.path, before, value));
      if (!same(before, value)) touched.push({ type, before, after: value });
    }
    const dropped = unset.filter((k) => Object.prototype.hasOwnProperty.call(next, k));
    if (dropped.length) {
      next = { ...next };
      for (const key of dropped) delete next[key];
    }
    const result = { changes, approval };
    if (dryRun || (!touched.length && !dropped.length)) return { result };

    const states = touched.map((t) => {
      const hooks = writeHooks.get(t.type.id);
      const ctx = { type: t.type, scope, projectDir, before: t.before, after: t.after, actor, via };
      return { hooks, ctx, state: hooks && hooks.beforeWrite ? hooks.beforeWrite(ctx) : undefined };
    });
    store.write(next);
    for (const { hooks, ctx, state } of states) {
    if (hooks && hooks.afterWriteLocked) hooks.afterWriteLocked(ctx, state);
    }
    return { result, states, dropped };
  }
  const { result, states, dropped } = dryRun ? apply() : stores.withWriteLock(apply);
  if (!states) return result;
  for (const { hooks, ctx, state } of states) {
    if (hooks && hooks.afterWrite) hooks.afterWrite(ctx, state);
  }
  events.emit('content_changed', {
    scope,
    projectDir: scope === 'project' ? projectDir : null,
    keys: [...new Set([...resolved.map((e) => e.type.path.split('.')[0]), ...dropped])],
    types: resolved.map((e) => e.type.id),
    actor: remote ? 'share' : actor
  });
  return result;
}

module.exports = { applyPatch, writeType, writeMany, checkWrite, onWrite, readType, warningsFor, validateKey, events, carrySecrets };
