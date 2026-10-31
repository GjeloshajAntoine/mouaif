'use strict';

// Custom UI themes (docs/features/themes.md).
//
// The built-in themes live in the web bundle (frontend/src/theme/builtin.js);
// this module stores the user's own themes and the active theme id in the
// app-level store under one key, `themes`:
//
//   { active: '<theme id>', custom: [Theme, ...] }
//   Theme = { id, name, base: 'dark'|'light', vars: { '--token': value },
//             css: string, js: string, updatedAt: ISO string }
//
// `themes` is deliberately NOT in CLIENT_SETTINGS_KEYS: a theme can carry up
// to MAX_JS_BYTES of script, and GET /api/settings is read by many views. The
// UI reads themes through /api/themes instead, and the script itself through
// /api/themes/<id>/script.js so the page CSP (`script-src 'self'`) can load it
// without allowing inline script or eval.

const crypto = require('node:crypto');
const settings = require('./settings.js');

const STORE_KEY = 'themes';
const MAX_THEMES = 50;
const MAX_NAME = 60;
const MAX_VARS = 80;
const MAX_VAR_VALUE = 300;
const MAX_CSS_BYTES = 100 * 1024;
const MAX_JS_BYTES = 200 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const VAR_RE = /^--[A-Za-z0-9_-]{1,48}$/;

class ThemeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function readStore() {
  const raw = settings.getApp()[STORE_KEY];
  const store = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    active: typeof store.active === 'string' ? store.active : '',
    custom: Array.isArray(store.custom) ? store.custom.filter((t) => t && typeof t.id === 'string') : []
  };
}

function writeStore(store) {
  settings.setApp({ [STORE_KEY]: { active: store.active || '', custom: store.custom } });
}

// version(theme) — a short content hash. The client appends it to the script
// URL so an edited script is fetched fresh instead of reusing the module the
// browser already imported under the old URL.
function version(theme) {
  return crypto.createHash('sha1')
    .update(JSON.stringify([theme.base, theme.vars, theme.css, theme.js]))
    .digest('hex').slice(0, 12);
}

// summary(theme) — what the picker and the boot path need. The script body
// stays out; `hasJs` and `version` are enough to import it.
function summary(theme) {
  return {
    id: theme.id,
    name: theme.name,
    base: theme.base,
    vars: theme.vars,
    css: theme.css,
    hasJs: !!theme.js,
    jsBytes: Buffer.byteLength(theme.js || ''),
    version: version(theme),
    updatedAt: theme.updatedAt || ''
  };
}

function full(theme) {
  return { ...summary(theme), js: theme.js || '' };
}

function text(value, field, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ThemeError(field + ' must be a string');
  if (Buffer.byteLength(value) > max) throw new ThemeError(field + ' is larger than ' + Math.round(max / 1024) + ' KB');
  return value;
}

// sanitize(input) — validate one theme body from the client. Unknown keys are
// dropped. Token values are applied with style.setProperty() on the client,
// which cannot break out of the declaration, but `;{}` are still refused so a
// stored value always means exactly one CSS value.
function sanitize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ThemeError('theme must be an object');
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, MAX_NAME) : '';
  if (!name) throw new ThemeError('name is required');
  const base = input.base === 'light' ? 'light' : 'dark';
  const vars = {};
  const rawVars = input.vars && typeof input.vars === 'object' && !Array.isArray(input.vars) ? input.vars : {};
  const entries = Object.entries(rawVars);
  if (entries.length > MAX_VARS) throw new ThemeError('a theme can set at most ' + MAX_VARS + ' tokens');
  for (const [key, value] of entries) {
    if (!VAR_RE.test(key)) throw new ThemeError('invalid token name: ' + key);
    if (typeof value !== 'string') throw new ThemeError('token ' + key + ' must be a string');
    const v = value.trim();
    if (!v) continue;
    if (v.length > MAX_VAR_VALUE || /[;{}<>]/.test(v)) throw new ThemeError('invalid value for ' + key);
    vars[key] = v;
  }
  return {
    name,
    base,
    vars,
    css: text(input.css, 'css', MAX_CSS_BYTES),
    js: text(input.js, 'js', MAX_JS_BYTES)
  };
}

function newId(name, taken) {
  const slug = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'theme';
  let id;
  do { id = 'custom-' + slug + '-' + crypto.randomBytes(3).toString('hex'); } while (taken.has(id));
  return id;
}

function list() {
  const store = readStore();
  return { active: store.active, themes: store.custom.map(summary) };
}

function get(id) {
  const theme = readStore().custom.find((t) => t.id === id);
  return theme ? full(theme) : null;
}

function create(input) {
  const store = readStore();
  if (store.custom.length >= MAX_THEMES) throw new ThemeError('at most ' + MAX_THEMES + ' custom themes');
  const clean = sanitize(input);
  const theme = { id: newId(clean.name, new Set(store.custom.map((t) => t.id))), ...clean, updatedAt: new Date().toISOString() };
  store.custom.push(theme);
  writeStore(store);
  return full(theme);
}

function update(id, input) {
  const store = readStore();
  const index = store.custom.findIndex((t) => t.id === id);
  if (index < 0) throw new ThemeError('theme not found', 404);
  const theme = { id, ...sanitize(input), updatedAt: new Date().toISOString() };
  store.custom[index] = theme;
  writeStore(store);
  return full(theme);
}

function remove(id) {
  const store = readStore();
  const next = store.custom.filter((t) => t.id !== id);
  if (next.length === store.custom.length) throw new ThemeError('theme not found', 404);
  store.custom = next;
  if (store.active === id) store.active = '';
  writeStore(store);
  return { active: store.active };
}

// setActive(id) — built-in ids are owned by the bundle, so any well-formed id
// is accepted; an id that matches nothing falls back to the default theme on
// the client. An empty id means "the default theme".
function setActive(id) {
  const value = typeof id === 'string' ? id : '';
  if (value && !ID_RE.test(value)) throw new ThemeError('invalid theme id');
  const store = readStore();
  store.active = value;
  writeStore(store);
  return { active: value };
}

function script(id) {
  const theme = readStore().custom.find((t) => t.id === id);
  return theme ? theme.js || '' : null;
}

module.exports = {
  ThemeError,
  ID_RE,
  MAX_JS_BYTES,
  MAX_CSS_BYTES,
  list,
  get,
  create,
  update,
  remove,
  setActive,
  script
};
