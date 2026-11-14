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
const { diffKey, isPlainObject, same } = require('./changes.js');
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

  const store = stores.storeFor('settings', scope, projectDir);
  const current = store.read();
  const next = { ...current };
  for (const key of Object.keys(body)) {
    const value = prepareValue(key, clone(body[key]), current[key]);
    // Validate on write only, and only what changes: the raw project editor
    // re-sends every key, and a hand-edited value it did not touch must not
    // block the save (reads report it as a warning instead).
    if (!same(value, current[key])) validateKey(key, value, scope);
    next[key] = value;
  }
  for (const key of removing) delete next[key];

  const changes = [];
  for (const key of keys) changes.push(...diffKey(key, current[key], next[key], { scope }));
  const result = { changes, warnings: [], approval, document: next };
  if (dryRun || !keys.length) return result;

  result.document = store.write(next);
  events.emit('content_changed', {
    scope,
    projectDir: scope === 'project' ? projectDir : null,
    keys,
    types: [...new Set(changes.map((c) => c.type))],
    actor: remote ? 'share' : actor
  });
  return result;
}

module.exports = { applyPatch, warningsFor, validateKey, events, carrySecrets };
