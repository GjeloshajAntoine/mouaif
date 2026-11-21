// mouaif web — shared API client and settings helpers
import { signal } from '@preact/signals';
import { connectionHealth, healthWithoutAsking } from './providerChoices.js';

// ---- API client --------------------------------------------------------

export async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body; try { body = JSON.parse(text || '{}'); } catch { body = text; }
  return { status: r.status, body };
}

// ---- Settings shared data ---------------------------------------------

let _appCache = null;
let _appCacheAt = 0;
const APP_CACHE_TTL_MS = 4000;

export async function loadApp({ force = false } = {}) {
  const now = Date.now();
  if (!force && _appCache && (now - _appCacheAt) < APP_CACHE_TTL_MS) return _appCache;
  const r = await fetchJson('/api/settings');
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  _appCache = r.body || {};
  _appCacheAt = now;
  return _appCache;
}

export function appProviders() {
  return (_appCache && Array.isArray(_appCache.app && _appCache.app.providers)) ? _appCache.app.providers : [];
}

export async function saveApp(patch) {
  const r = await fetchJson('/api/settings/app', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch || {})
  });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  _appCache = Object.assign({}, _appCache, { app: r.body.app || (_appCache && _appCache.app) || {} });
  return _appCache;
}

export async function resetAppKeys(keys) {
  const r = await fetchJson('/api/settings/app/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: keys || [] })
  });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  _appCache = Object.assign({}, _appCache, { app: r.body.app || {} });
  return _appCache;
}

let _accountsCache = null;
let _accountsCacheAt = 0;
const ACCOUNTS_CACHE_TTL_MS = 5000;

export async function loadAccounts({ force = false } = {}) {
  const now = Date.now();
  if (!force && _accountsCache && (now - _accountsCacheAt) < ACCOUNTS_CACHE_TTL_MS) return _accountsCache;
  const r = await fetchJson('/api/auth/accounts');
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  _accountsCache = (r.body && r.body.accounts) || {};
  _accountsCacheAt = now;
  return _accountsCache;
}

// checkConnection(connection, { force }) — does this saved connection work?
// Listing its models is the one call providers answer without spending anything.
// Without `force` the server may answer from its model-list cache, so the provider
// list can check every row on each visit.
export async function checkConnection(connection, { force = false } = {}) {
  const known = healthWithoutAsking(connection);
  if (known) return known;
  const query = 'provider=' + encodeURIComponent(connection.id) + (force ? '&_bust=1' : '');
  try {
    const r = await fetchJson('/api/ai/models/live?' + query);
    return connectionHealth(r.status, r.body, connection);
  } catch {
    return { state: 'unknown', text: 'Couldn\'t check', detail: '' };
  }
}

// ---- Models list cache ------------------------------------------------

export async function loadModels(projectDir, { force = false } = {}) {
  const r = await fetchJson('/api/ai/models?projectDir=' + encodeURIComponent(projectDir));
  if (r.status !== 200) return { models: [] };
  return { models: r.body.models || [], projectDir };
}

export function invalidateModelsCache() {
  // No-op (relying entirely on server-side model cache)
}

// ---- Live models cache ------------------------------------------------

export async function fetchLiveModels(provider, { force = false, purpose = '' } = {}) {
  // Convert force to an extra parameter so the server also knows whether to bypass its internal Map cache.
  // `purpose` ('image' | 'transcription') asks the server for that slice of
  // the provider's catalog instead of the chat list; a provider with no
  // separate slice returns its chat list, so the caller can ask on every
  // provider and union the answers.
  const r = await fetchJson('/api/ai/models/live?provider=' + encodeURIComponent(provider)
    + (force ? '&_bust=1' : '')
    + (purpose ? '&purpose=' + encodeURIComponent(purpose) : ''));
  if (r.status !== 200) return { error: r.body, status: r.status, provider };
  const models = Array.isArray(r.body && r.body.models) ? r.body.models : [];
  return { models, cached: r.body.cached, provider };
}

export function invalidateLiveModelsCache(provider) {
  // No-op (relying entirely on server-side model cache)
}

export const SETTINGS_PROVIDERS = [
  // `oauth: true` means the server has an OAuth sign-in flow registered for
  // this provider (see src/index.js → oauth*.register()). ONLY those may show
  // the OAuth auth option; the others are API-key only, and offering OAuth for
  // them just leads to a 404 from POST /api/auth/sign-in/<id>. `reserved`
  // implies OAuth-only (no API-key alternative).
  //
  // `signInWith` names the service on a browser sign-in button. Azure has no
  // default URL because its address always contains your own names, so
  // `urlPlaceholder` shows the shape instead of pre-filling text that can't work.
  // The ways to add these providers are in ./providerChoices.js.
  { id: 'openai-compatible', label: 'OpenAI compatible',  defaultBaseUrl: 'https://api.openai.com/v1',                hint: 'Any OpenAI-shaped API, hosted or on your own server. A local server may not need a key.' },
  { id: 'anthropic',         label: 'Anthropic',          defaultBaseUrl: 'https://api.anthropic.com',                hint: 'Paste an API key, or sign in with Claude Pro or Max.', oauth: true, signInWith: 'Claude' },
  { id: 'gemini',            label: 'Google Gemini',      defaultBaseUrl: 'https://generativelanguage.googleapis.com', hint: 'Paste an API key from Google AI Studio.' },
  { id: 'codex',             label: 'OpenAI Codex',       defaultBaseUrl: 'https://chatgpt.com/backend-api/codex', hint: 'Sign in with a one-time ChatGPT code. Turn on device code authorization in ChatGPT under Settings → Security first. To use an API key, add OpenAI instead.', reserved: true, oauth: true, deviceAuth: true },
  { id: 'ollama',            label: 'Ollama',             defaultBaseUrl: 'http://127.0.0.1:11434',                   hint: 'An Ollama server you run. No API key needed.' },
  { id: 'openrouter',        label: 'OpenRouter',         defaultBaseUrl: 'https://openrouter.ai/api/v1',             hint: 'One account, many models. Paste an API key, or sign in and OpenRouter creates a key for mouaif.', oauth: true, signInWith: 'OpenRouter' },
  { id: 'github-copilot',    label: 'GitHub Copilot',     defaultBaseUrl: 'https://api.githubcopilot.com',            hint: 'Sign in with a GitHub one-time code, from this device or any other. The account needs an active Copilot plan.', reserved: true, oauth: true, deviceAuth: true },
  { id: 'azure',             label: 'Azure OpenAI',       urlPlaceholder: 'https://<resource>.openai.azure.com/openai/deployments/<deployment>', hint: 'Enter your deployment URL with your own resource and deployment names, then paste its key.' },
  { id: 'mistral',           label: 'Mistral',            defaultBaseUrl: 'https://api.mistral.ai/v1',                hint: 'Paste an API key from console.mistral.ai.' },
  { id: 'groq',              label: 'Groq',               defaultBaseUrl: 'https://api.groq.com/openai/v1',           hint: 'Paste an API key from console.groq.com.' },
  { id: 'deepseek',          label: 'DeepSeek',           defaultBaseUrl: 'https://api.deepseek.com',                 hint: 'Paste an API key from platform.deepseek.com.' }
];

export function providerDef(id) {
  return SETTINGS_PROVIDERS.find(p => p.id === id) || null;
}

// connectionType(connection) — which SETTINGS_PROVIDERS entry a connection is.
// A connection saved before a type could have several has no `type`, because
// its id is its type.
export function connectionType(connection) {
  return (connection && (connection.type || connection.id)) || '';
}

// providerLabel(id) — how a provider connection reads in a picker: the name the
// user gave it, else its id. Keys, filters and saved selections keep the id.
export function providerLabel(id) {
  const connection = appProviders().find(p => p && p.id === id);
  return (connection && connection.name) || id;
}

// authNsForProvider(id) — the *auth* (keyring) namespace a provider connection
// signs in under. It mirrors src/auth.js `AI_TO_AUTH_PROVIDER`; it is
// duplicated here because the web bundle cannot require the server module. The
// two tables are pinned together by scripts/test-provider-namespaces.js, which
// fails if they drift — the previous copy mapped `openai-compatible` but not
// `gemini`, so the provider form looked up `accounts.gemini` while the server
// indexed that account under `google`, and a signed-in Gemini account was
// invisible to the picker.
const PROVIDER_AUTH_NAMESPACE = Object.freeze({
  'openai-compatible': 'openai',
  'gemini': 'google'
});

export function authNsForProvider(id) {
  return PROVIDER_AUTH_NAMESPACE[id] || id;
}

// ---- Model recent (server-side, SQLite) -----------------------------
//
// One app-wide list: the same recent models follow the user across every
// project, because a model id is an app-level resource (its provider
// connection lives in app settings). No `projectDir` is sent.

export async function loadRecentModels() {
  const r = await fetchJson('/api/settings/models/recent');
  if (r.status !== 200) return [];
  return Array.isArray(r.body && r.body.recent) ? r.body.recent : [];
}

export async function touchRecentModel(provider, modelId) {
  if (!provider || !modelId) return;
  await fetchJson('/api/settings/models/recent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, modelId })
  });
}

export async function clearRecentModels() {
  await fetchJson('/api/settings/models/recent', { method: 'DELETE' });
}

// ---- Project settings storage (file vs DB) ---------------------------
export async function getProjectStorage(projectDir) {
  if (!projectDir) return { dbBacked: false };
  const r = await fetchJson('/api/settings/project/storage?projectDir=' + encodeURIComponent(projectDir));
  if (r.status !== 200) return { dbBacked: false };
  return { dbBacked: !!r.body.dbBacked };
}
export async function setProjectStorage(projectDir, dbBacked) {
  const r = await fetchJson('/api/settings/project/storage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir, dbBacked: !!dbBacked })
  });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  return { dbBacked: !!r.body.dbBacked, project: r.body.project || {}, path: r.body.path || null };
}

// ---- Web preview refresh ----------------------------------------------
// Direct user-facing refresh of the web preview from the full-screen
// viewer. The user can change the capture resolution with `viewport`
// (preset id like 'phone'/'tablet', or a 'WIDTHxHEIGHT' string). Returns
// the native tool result ({ ok, url, title, thumbnail, width, height,
// viewport, ... }) or throws a decoded error on a non-2xx response.
export async function requestWebpreview({ projectDir, chatId, url, viewport, callId }) {
  const body = { projectDir, chatId, url };
  if (viewport) body.viewport = viewport;
  if (callId) body.callId = callId;
  const r = await fetchJson('/api/tools/webpreview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status === 409 && r.body && r.body.code === 'EAUTH_REQUIRED') {
    const e = new Error(r.body.error || 'Authorization required');
    e.code = 'EAUTH_REQUIRED';
    e.callId = r.body.callId || '';
    throw e;
  }
  if (r.status !== 200) {
    const e = new Error((r.body && r.body.error) || 'HTTP ' + r.status);
    e.code = (r.body && r.body.code) || 'EHTTP';
    throw e;
  }
  return r.body;
}
// ---- Tiny toast helper -----------------------------------------------
export function setStatus(ref, text, state) {
  if (!ref || !ref.current) return;
  ref.current.textContent = text || '';
  if (state) ref.current.dataset.state = state;
  else delete ref.current.dataset.state;
}

// ---- SSE parser -------------------------------------------------------

export function parseSSEFrame(frame) {
  let eventName = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length) return null;
  return { eventName, data: dataLines.join('\n') };
}

// ---- Shared signals ---------------------------------------------------

export const projectsReload = signal(0);
export const route = signal({ name: 'chats' });

// Active project — the project the user is currently looking at on a
// project-scoped screen. Set when entering a chat, the project picker,
// Settings → Project, or any view that needs to know the project.
// Read by SettingsPrompts and similar project-scoped views. Persisted
// across route changes so navigating to Settings and back keeps the
// context.
export const activeProject = signal({ dir: '', name: '' });

export function setActiveProject(dir, name) {
  activeProject.value = { dir: dir || '', name: name || '' };
}

export function clearActiveProject() {
  activeProject.value = { dir: '', name: '' };
}

// ---- Shared projects (docs/features/share-project.md) -----------------
//
// A project added from another mouaif ("Shared with me") lives on the
// machine that has its folder. Its project-scoped calls go to
// `/s/<share>/api/…` on this mouaif, which forwards them there. Everything
// else — models, providers, dictation, app settings — stays on this mouaif,
// because the mouaif being used supplies the models.
//
// One helper decides, for every call: `shareUrl(url, body)` prefixes a
// project-scoped URL whose project is a shared one. `fetch` is wrapped once
// below so the many `fetch('/api/…')` call sites need no change; the places
// that cannot go through fetch (EventSource) call shareUrl themselves.

export const shareState = signal({ enabled: false, machine: '', incoming: [], outgoing: [], addresses: [], loaded: false });
const sharedByDir = new Map();

// Project-scoped routes, the client-side mirror of the server allowlist in
// src/share-gate.js. Anything not listed is never forwarded.
const SHARE_ROUTE_PREFIXES = [
  '/api/chats', '/api/settings/project', '/api/settings/resolved', '/api/settings/hide-file-content',
  '/api/file', '/api/prompts', '/api/agents', '/api/features', '/api/tools/', '/api/git',
  '/api/mcp/servers', '/api/mcp/call', '/api/actions', '/api/hooks/project', '/events'
];

const rawFetch = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : null;

function isShareRoute(pathname) {
  return SHARE_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/')
    || (p === '/api/file' && (pathname === '/api/files' || pathname === '/api/file-media')));
}

function bodyProjectDir(body) {
  if (typeof body !== 'string' || body.length > 2_000_000 || body.charAt(0) !== '{') return '';
  try { const parsed = JSON.parse(body); return parsed && typeof parsed.projectDir === 'string' ? parsed.projectDir : ''; }
  catch { return ''; }
}

// shareIdFor(dir) — the share id of an added shared project, or ''.
export function shareIdFor(dir) {
  return (dir && sharedByDir.get(dir)) || '';
}

// shareUrl(url, body?, dir?) — `url` itself, or `/s/<share>` + url when it is
// a project-scoped call of a shared project. The project comes from `dir`
// (for the few calls that name a terminal session instead of a project, such
// as the terminal's event stream), the `projectDir` query parameter, or the
// JSON body. A call that names no project stays on this mouaif.
export function shareUrl(url, body, dir) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('/s/') || !sharedByDir.size) return url;
  const q = url.indexOf('?');
  const pathname = q >= 0 ? url.slice(0, q) : url;
  if (!isShareRoute(pathname)) return url;
  let project = dir || '';
  if (!project && q >= 0) project = new URLSearchParams(url.slice(q + 1)).get('projectDir') || '';
  if (!project) project = bodyProjectDir(body);
  const id = shareIdFor(project);
  return id ? '/s/' + id + url : url;
}

let sharesReady = null;
// True when the last load could not read the list (signed out, offline):
// the next project-scoped call tries again, so signing in is enough.
let sharesStale = true;
let sharesLoading = false;
export async function loadShareState() {
  let next = null;
  let status = 0;
  try {
    const r = await (rawFetch || fetch)('/api/share/state');
    status = r.status;
    if (r.status === 200) next = await r.json();
  } catch { /* offline: no shares for now */ }
  // Signed out (401) or offline (0): try again on the next project call. Any
  // other answer (an older server's 404) means no sharing here.
  sharesStale = !next && (status === 0 || status === 401);
  sharedByDir.clear();
  const s = next || { enabled: false, machine: '', incoming: [], outgoing: [], addresses: [] };
  for (const share of s.incoming || []) {
    if (share.status === 'active') sharedByDir.set(share.projectDir, share.id);
  }
  shareState.value = Object.assign({}, s, { loaded: true });
  return shareState.value;
}

// Wrap fetch once. A project-scoped call waits for the first share list (one
// request at start-up) so a deep link into a shared chat is routed correctly.
if (rawFetch) {
  sharesLoading = true;
  sharesReady = loadShareState().catch(() => null).finally(() => { sharesLoading = false; });
  window.fetch = function shareAwareFetch(input, init) {
    if (typeof input === 'string' && input.startsWith('/api/') && isShareRoute(input.split('?')[0])) {
      if (sharesStale && !sharesLoading) {
        sharesLoading = true;
        sharesReady = loadShareState().catch(() => null).finally(() => { sharesLoading = false; });
      }
      return sharesReady.then(() => rawFetch(shareUrl(input, init && init.body), init));
    }
    return rawFetch(input, init);
  };
}

// whenSharesReady() -> Promise — resolves once the first share list is in, so
// a caller that cannot go through fetch (EventSource) routes a shared
// project's stream correctly.
export function whenSharesReady() {
  return sharesReady ? sharesReady.then(() => undefined, () => undefined) : Promise.resolve();
}

export async function shareApi(method, url, body) {
  const r = await fetchJson(url, body === undefined ? { method } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (r.status < 200 || r.status >= 300) {
    const e = new Error((r.body && r.body.error) || 'HTTP ' + r.status);
    e.code = r.body && r.body.code;
    e.status = r.status;
    throw e;
  }
  return r.body;
}