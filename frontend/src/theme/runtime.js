// frontend/src/theme/runtime.js — apply a theme to the running app.
//
// A theme reaches the page in three layers (docs/features/themes.md):
//   1. tokens — one <style> that overrides the base.css `:root` variables,
//      plus derived tokens (soft tints, press shades) the theme left unset;
//   2. css    — the theme's own stylesheet, in a second <style>;
//   3. js     — custom themes only: an ES module served same-origin from
//      /api/themes/<id>/script.js (the page CSP allows no inline script or
//      eval). Its default export is `setup(ctx)`, which may return a cleanup
//      function. Everything registered through `ctx` is torn down
//      automatically when the theme changes.
//
// Boot: main.jsx calls bootTheme() before the first render, which re-applies
// the last theme's tokens and CSS from localStorage so there is no flash of
// the default palette. The script only runs after App mounts (past the access
// gate) and refreshTheme() has fetched the current theme from the server.
//
// Safe mode: loading the app with `?safe` in the URL (before the `#`) skips
// every theme, so a script that breaks the UI can still be removed.

import { signal } from '@preact/signals';
import { fetchJson, route } from '../api.js';
import { BUILTIN_THEMES, DEFAULT_THEME_ID, findBuiltin } from './builtin.js';

const CACHE_KEY = 'mouaif.theme.v1';
const CHANNEL = 'mouaif-theme';
const TOKENS_ID = 'mouaif-theme-tokens';
const CSS_ID = 'mouaif-theme-css';
const VALUE_OK = /^[^;{}<>]*$/;

export const safeMode = (() => {
  try { return new URLSearchParams(window.location.search).has('safe'); } catch { return false; }
})();

// { active, themes: [custom summaries] } once loaded.
export const themeState = signal({ loaded: false, active: '', themes: [] });
// The last script failure: { themeId, message }, or null.
export const themeError = signal(null);

let applied = null;        // { id, version } of what is on the page
let teardown = null;       // cleanup of the running script
let applySeq = 0;          // drops stale async imports

// ---- Tokens + CSS -------------------------------------------------------

function styleEl(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  return el;
}

// Tokens a theme usually wants to follow its main colours. Only added when
// the theme sets the source token and leaves the derived one alone.
const DERIVED = [
  ['--accent', '--accent-soft', 'color-mix(in srgb, var(--accent) 16%, transparent)'],
  ['--accent', '--accent-press', 'color-mix(in srgb, var(--accent) 86%, black)'],
  ['--accent', '--accent-hi', 'color-mix(in srgb, var(--accent) 70%, white)'],
  ['--accent', '--accent-hi-2', 'color-mix(in srgb, var(--accent) 50%, white)'],
  ['--success', '--success-soft', 'color-mix(in srgb, var(--success) 14%, transparent)'],
  ['--warning', '--warning-soft', 'color-mix(in srgb, var(--warning) 14%, transparent)'],
  ['--danger', '--danger-soft', 'color-mix(in srgb, var(--danger) 18%, var(--bg))'],
  ['--muted', '--muted-2', 'color-mix(in srgb, var(--muted) 70%, var(--bg))'],
  ['--fg', '--border', 'color-mix(in srgb, var(--fg) 8%, transparent)']
];

export function tokenCss(theme) {
  const vars = { ...(theme.vars || {}) };
  for (const [source, target, value] of DERIVED) {
    if (vars[source] && !vars[target]) vars[target] = value;
  }
  const lines = Object.entries(vars)
    .filter(([name, value]) => /^--[A-Za-z0-9_-]+$/.test(name) && typeof value === 'string' && VALUE_OK.test(value))
    .map(([name, value]) => `  ${name}: ${value};`);
  lines.push(`  color-scheme: ${theme.base === 'light' ? 'light' : 'dark'};`);
  // `html:root` outranks the plain `:root` in base.css whatever the order the
  // stylesheets end up in.
  return `html:root {\n${lines.join('\n')}\n}`;
}

function setMeta(name, content) {
  const meta = document.querySelector(`meta[name="${name}"]`);
  if (meta) meta.setAttribute('content', content);
}

function paintStyles(theme) {
  // Extension views follow the theme (components/chat/appHostContext.js).
  queueMicrotask(() => { try { window.dispatchEvent(new CustomEvent('mouaif:theme-painted')); } catch { /* no window */ } });
  styleEl(TOKENS_ID).textContent = tokenCss(theme);
  styleEl(CSS_ID).textContent = theme.css || '';
  const root = document.documentElement;
  root.dataset.theme = theme.id || DEFAULT_THEME_ID;
  root.dataset.themeBase = theme.base === 'light' ? 'light' : 'dark';
  setMeta('color-scheme', root.dataset.themeBase);
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (bg) setMeta('theme-color', bg);
}

// ---- Script lifecycle ---------------------------------------------------

function stopScript() {
  const done = teardown;
  teardown = null;
  if (done) {
    try { done(); } catch (error) { console.error('[theme] cleanup failed', error); }
  }
}

function report(theme, error) {
  const message = (error && (error.message || String(error))) || 'unknown error';
  console.error('[theme] script for "' + theme.name + '" failed:', error);
  themeError.value = { themeId: theme.id, message };
}

// makeContext(theme) — the API handed to a theme's setup(). Everything it
// registers is undone by the returned dispose(), so a theme script only has
// to clean up what it did by hand.
function makeContext(theme) {
  const controller = new AbortController();
  const disposers = [];
  const own = (fn) => { disposers.push(fn); return fn; };
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;

  const ctx = {
    theme: { id: theme.id, name: theme.name, base: theme.base, vars: { ...(theme.vars || {}) } },
    root,
    app: document.getElementById('app'),
    signal: controller.signal,
    get reducedMotion() { return motion.matches; },
    get route() { return route.value; },
    // addStyle(css) — a stylesheet that lives as long as the theme.
    addStyle(css) {
      const el = document.createElement('style');
      el.dataset.themeScript = theme.id;
      el.textContent = String(css);
      document.head.appendChild(el);
      return own(() => el.remove());
    },
    // setVar(name, value) — set a token from code (e.g. pointer position).
    setVar(name, value) {
      root.style.setProperty(name, String(value));
      own(() => root.style.removeProperty(name));
    },
    // onRoute(fn) — called now and on every navigation with the route object.
    onRoute(fn) {
      const off = route.subscribe((value) => {
        try { fn(value); } catch (error) { report(theme, error); }
      });
      return own(off);
    },
    // onFrame(fn) — a requestAnimationFrame loop: fn(timeMs, deltaMs). Pauses
    // while the tab is hidden and stops with the theme. Return false to stop.
    onFrame(fn) {
      let raf = 0;
      let last = 0;
      let stopped = false;
      const tick = (now) => {
        if (stopped) return;
        const dt = last ? now - last : 16;
        last = now;
        let keep;
        try { keep = fn(now, dt); } catch (error) { report(theme, error); keep = false; }
        if (keep === false) { stopped = true; return; }
        raf = requestAnimationFrame(tick);
      };
      const onVisibility = () => {
        cancelAnimationFrame(raf);
        last = 0;
        if (!stopped && !document.hidden) raf = requestAnimationFrame(tick);
      };
      document.addEventListener('visibilitychange', onVisibility, { signal: controller.signal });
      raf = requestAnimationFrame(tick);
      return own(() => { stopped = true; cancelAnimationFrame(raf); });
    },
    // onMotionChange(fn) — the user toggled reduced motion.
    onMotionChange(fn) {
      motion.addEventListener('change', () => fn(motion.matches), { signal: controller.signal });
    }
  };

  const dispose = () => {
    controller.abort();
    while (disposers.length) {
      try { disposers.pop()(); } catch (error) { console.error('[theme] cleanup failed', error); }
    }
  };
  return { ctx, dispose };
}

async function runScript(theme, seq) {
  const url = '/api/themes/' + encodeURIComponent(theme.id) + '/script.js?v=' + encodeURIComponent(theme.version || '');
  let mod;
  try {
    mod = await import(/* @vite-ignore */ url);
  } catch (error) {
    if (seq === applySeq) report(theme, error);
    return;
  }
  if (seq !== applySeq) return;
  const setup = typeof mod.default === 'function' ? mod.default : (typeof mod.setup === 'function' ? mod.setup : null);
  if (!setup) return;
  const { ctx, dispose } = makeContext(theme);
  let cleanup = null;
  try {
    cleanup = await setup(ctx);
  } catch (error) {
    dispose();
    report(theme, error);
    return;
  }
  const finish = () => {
    if (typeof cleanup === 'function') {
      try { cleanup(); } catch (error) { console.error('[theme] cleanup failed', error); }
    }
    dispose();
  };
  if (seq !== applySeq) { finish(); return; }
  teardown = finish;
}

// Errors thrown later by theme code (timers, listeners) surface here; the
// script URL identifies which theme threw.
window.addEventListener('error', (event) => {
  const match = /\/api\/themes\/([^/]+)\/script\.js/.exec(event.filename || '');
  if (!match) return;
  const id = decodeURIComponent(match[1]);
  const theme = themeState.value.themes.find((t) => t.id === id);
  report(theme || { id, name: id }, event.error || event.message);
});

// ---- Apply ----------------------------------------------------------------

function cache(theme) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      id: theme.id, name: theme.name, base: theme.base, vars: theme.vars || {}, css: theme.css || ''
    }));
  } catch { /* storage unavailable */ }
}

// applyTheme(theme, { script }) — paint tokens and CSS, then (re)start the
// theme's script if it has one and `script` is true. Re-applying the theme
// that is already running, unchanged, leaves its script alone.
export function applyTheme(theme, { script = true } = {}) {
  const same = applied && applied.id === theme.id && applied.version === (theme.version || '') && applied.script === script;
  paintStyles(theme);
  if (same) return;
  applySeq += 1;
  stopScript();
  if (themeError.value && themeError.value.themeId === theme.id) themeError.value = null;
  applied = { id: theme.id, version: theme.version || '', script };
  if (script && theme.hasJs && !safeMode) runScript(theme, applySeq);
}

// resolveTheme(id) — a built-in, a custom theme from the last load, or the
// default when the id matches nothing.
export function resolveTheme(id, themes = themeState.value.themes) {
  return findBuiltin(id) || themes.find((t) => t.id === id) || findBuiltin(DEFAULT_THEME_ID);
}

export function allThemes(themes = themeState.value.themes) {
  return [...BUILTIN_THEMES.map((t) => ({ ...t, builtin: true })), ...themes];
}

export function bootTheme() {
  if (safeMode) return;
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached && cached.id) paintStyles(cached);
  } catch { /* storage unavailable or corrupt */ }
}

// refreshTheme() — fetch the themes and apply the active one, script included.
export async function refreshTheme() {
  const r = await fetchJson('/api/themes');
  if (r.status !== 200) return themeState.value;
  const next = { loaded: true, active: r.body.active || '', themes: Array.isArray(r.body.themes) ? r.body.themes : [] };
  themeState.value = next;
  if (safeMode) {
    paintStyles(findBuiltin(DEFAULT_THEME_ID));
    return next;
  }
  const theme = resolveTheme(next.active, next.themes);
  applyTheme(theme);
  cache(theme);
  return next;
}

// restoreTheme() — put the active theme back after a preview.
export function restoreTheme() {
  if (safeMode) { paintStyles(findBuiltin(DEFAULT_THEME_ID)); return; }
  applyTheme(resolveTheme(themeState.value.active));
}

// previewTheme(draft) — show a theme's tokens and CSS without running any
// script (the editor's live preview).
export function previewTheme(draft) {
  applyTheme({ ...draft, version: 'preview:' + Date.now(), hasJs: false }, { script: false });
}

// ---- Writes ---------------------------------------------------------------

let channel = null;
try {
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = () => { refreshTheme().catch(() => {}); };
} catch { /* BroadcastChannel unavailable */ }

function announce() {
  try { channel && channel.postMessage('changed'); } catch { /* ignore */ }
}

async function call(url, method, body) {
  const r = await fetchJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (r.status !== 200) throw new Error((r.body && r.body.error) || 'HTTP ' + r.status);
  return r.body;
}

export async function setActiveTheme(id) {
  await call('/api/themes/active', 'PUT', { id });
  const state = await refreshTheme();
  announce();
  return state;
}

export async function loadThemeSource(id) {
  const r = await fetchJson('/api/themes/' + encodeURIComponent(id));
  if (r.status !== 200) throw new Error((r.body && r.body.error) || 'HTTP ' + r.status);
  return r.body.theme;
}

export async function saveTheme(id, theme) {
  const body = id
    ? await call('/api/themes/' + encodeURIComponent(id), 'PUT', theme)
    : await call('/api/themes', 'POST', theme);
  await refreshTheme();
  announce();
  return body.theme;
}

export async function deleteTheme(id) {
  await call('/api/themes/' + encodeURIComponent(id), 'DELETE');
  await refreshTheme();
  announce();
}
