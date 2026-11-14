'use strict';

// Change lists: what a write did, in a shape every surface renders the same
// way — the chat card for update_settings, the approval card (from a dry run)
// and the "saved" line of a settings page.
//
//   value  { type, scope, op: 'set' | 'unset', key, label, before, after, page }
//   item   { type, scope, op: 'added' | 'changed' | 'removed', id, label, page,
//            fields: [{ key, label, before, after } | { …, large, beforeSize, afterSize }
//                     | { …, secret, before: 'set' | 'not set', after }] }
//
// Secret fields never carry their value, and large fields (prompt text, theme
// CSS and script) carry sizes only, so a transcript does not store them twice.
// An unregistered project key appears with its key as the label and its raw
// JSON value.

const registry = require('./registry.js');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
}

function getAt(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function size(value) {
  if (value === undefined || value === null) return 0;
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function secretState(value) {
  return typeof value === 'string' ? (value ? 'set' : 'not set') : (value === undefined || value === null ? 'not set' : 'set');
}

// Shape one before/after pair for display according to its field flags.
function shapePair(field, before, after) {
  if (field && field.secret) return { secret: true, before: secretState(before), after: secretState(after) };
  if (field && field.large) return { large: true, beforeSize: size(before), afterSize: size(after) };
  return { before, after };
}

function pageFor(type, scope) {
  if (!type) return null;
  return (scope === 'project' && type.projectPage) || type.page || null;
}

function itemPage(type, id) {
  if (!type.itemPage || id === undefined || id === null) return pageFor(type);
  return type.itemPage.replace(':id', encodeURIComponent(String(id)));
}

// ---- Values --------------------------------------------------------------

function valueChange(type, scope, key, before, after) {
  const op = after === undefined ? 'unset' : 'set';
  return Object.assign(
    { type: type ? type.id : key, scope, op, key, label: type ? registry.labelFor(type) : key, page: pageFor(type, scope) },
    shapePair(type && type.field, before, after),
    type ? {} : { raw: true }
  );
}

// ---- Collections ---------------------------------------------------------

// Items of a collection as [id, item] pairs, in stored order.
function entriesOf(type, value) {
  if (type.container === 'map') {
    return isPlainObject(value) ? Object.keys(value).map((k) => [k, value[k]]) : [];
  }
  if (!Array.isArray(value)) return [];
  return value.map((item, i) => {
    const id = isPlainObject(item) && item[type.itemId] !== undefined && item[type.itemId] !== null
      ? String(item[type.itemId]) : '#' + i;
    return [id, item];
  });
}

function itemLabel(type, id, item) {
  const noun = type.itemNoun || type.label;
  const name = type.itemLabel && isPlainObject(item) && typeof item[type.itemLabel] === 'string' && item[type.itemLabel]
    ? item[type.itemLabel] : id;
  return noun + ' “' + name + '”';
}

function fieldChanges(type, before, after, { addedOnly = false } = {}) {
  const b = isPlainObject(before) ? before : {};
  const a = isPlainObject(after) ? after : {};
  const keys = [];
  for (const k of [...Object.keys(a), ...Object.keys(b)]) if (!keys.includes(k)) keys.push(k);
  const out = [];
  for (const key of keys) {
    if (type.container === 'array' && key === type.itemId) continue;
    if (key === 'hasApiKey') continue;
    if (same(b[key], a[key])) continue;
    if (addedOnly && (a[key] === undefined || a[key] === '' || a[key] === null)) continue;
    const field = (type.fields || {})[key];
    out.push(Object.assign({ key, label: (field && field.label) || key }, shapePair(field, b[key], a[key])));
  }
  return out;
}

function collectionChanges(type, scope, before, after) {
  const prior = new Map(entriesOf(type, before));
  const next = entriesOf(type, after);
  const out = [];
  const seen = new Set();
  for (const [id, item] of next) {
    seen.add(id);
    const base = { type: type.id, scope, id, label: itemLabel(type, id, item), page: itemPage(type, id) };
    if (!prior.has(id)) {
      out.push(Object.assign(base, { op: 'added', fields: fieldChanges(type, undefined, item, { addedOnly: true }) }));
      continue;
    }
    const fields = fieldChanges(type, prior.get(id), item);
    if (fields.length) out.push(Object.assign(base, { op: 'changed', fields }));
  }
  for (const [id, item] of prior) {
    if (seen.has(id)) continue;
    out.push({ type: type.id, scope, id, op: 'removed', label: itemLabel(type, id, item), page: pageFor(type, scope) });
  }
  return out;
}

// ---- One top-level key ---------------------------------------------------

// diffKey(key, before, after, { scope }) -> [change]. `before` and `after`
// are the stored values of one top-level key of the settings document at one
// scope; `undefined` means absent.
function diffKey(key, before, after, { scope }) {
  if (same(before, after)) return [];
  const types = registry.typesForRoot(key).filter((t) => t.scopes.includes(scope));
  const exact = types.find((t) => t.path === key);
  if (exact && exact.shape === 'collection') return collectionChanges(exact, scope, before, after);
  if (exact) return [valueChange(exact, scope, key, before, after)];
  if (!types.length) return [valueChange(null, scope, key, before, after)];

  // A key split into declared parts (`toolOutput.size`, `toolWording.sets`):
  // one change per part, plus one per undeclared sub-key.
  const out = [];
  const covered = new Set();
  for (const t of types) {
    const rest = t.path.split('.').slice(1);
    covered.add(rest[0]);
    const b = getAt(before, rest);
    const a = getAt(after, rest);
    if (same(b, a)) continue;
    if (t.shape === 'collection') out.push(...collectionChanges(t, scope, b, a));
    else out.push(valueChange(t, scope, t.path, b, after === undefined ? undefined : a));
  }
  const bo = isPlainObject(before) ? before : {};
  const ao = isPlainObject(after) ? after : {};
  for (const sub of new Set([...Object.keys(bo), ...Object.keys(ao)])) {
    if (covered.has(sub) || same(bo[sub], ao[sub])) continue;
    out.push(valueChange(null, scope, key + '.' + sub, bo[sub], after === undefined ? undefined : ao[sub]));
  }
  if (!out.length) out.push(valueChange(null, scope, key, before, after));
  return out;
}

module.exports = { diffKey, collectionChanges, same, isPlainObject };
