// mouaif web — shared API client and settings helpers
import { signal } from '@preact/signals';

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

export async function fetchLiveModels(provider, { force = false } = {}) {
  // Convert force to an extra parameter so the server also knows whether to bypass its internal Map cache.
  const r = await fetchJson('/api/ai/models/live?provider=' + encodeURIComponent(provider) + (force ? '&_bust=1' : ''));
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
  { id: 'openai-compatible', label: 'OpenAI compatible',  defaultBaseUrl: 'https://api.openai.com/v1',                hint: 'OpenAI, Together, Groq, LM Studio, Ollama (via /v1), any OpenAI-shaped API.' },
  { id: 'anthropic',         label: 'Anthropic',          defaultBaseUrl: 'https://api.anthropic.com',                hint: 'Claude Messages API. Use the OAuth flow below for Claude Pro/Max; otherwise paste an API key.', oauth: true },
  { id: 'gemini',            label: 'Google Gemini',      defaultBaseUrl: 'https://generativelanguage.googleapis.com', hint: 'Google AI Studio / Gemini API. API key authentication.' },
  { id: 'ollama',            label: 'Ollama',             defaultBaseUrl: 'http://127.0.0.1:11434',                   hint: 'Local Ollama server. No API key required.' },
  { id: 'openrouter',        label: 'OpenRouter',         defaultBaseUrl: 'https://openrouter.ai/api/v1',             hint: 'OpenRouter: one API key, many models (OpenAI, Anthropic, Google, etc.) via a single OpenAI-shaped endpoint. Paste an API key, or sign in with OpenRouter (PKCE) and the app receives a user-controlled API key.', oauth: true },
  { id: 'github-copilot',    label: 'GitHub Copilot',     defaultBaseUrl: 'https://api.githubcopilot.com',            hint: 'Requires OAuth. A Copilot subscription on the signed-in account is required to chat.', reserved: true, oauth: true },
  { id: 'azure',             label: 'Azure OpenAI',       defaultBaseUrl: 'https://<resource>.openai.azure.com/openai/deployments/<deployment>', hint: 'Azure OpenAI. Set the resource + deployment in the base URL (or set apiVersion in the project model). API key authentication.' },
  { id: 'mistral',           label: 'Mistral',            defaultBaseUrl: 'https://api.mistral.ai/v1',                hint: 'Mistral AI (La Plateforme). API key authentication.' },
  { id: 'groq',              label: 'Groq',               defaultBaseUrl: 'https://api.groq.com/openai/v1',           hint: 'Groq — fast inference for open models. API key authentication.' },
  { id: 'deepseek',          label: 'DeepSeek',           defaultBaseUrl: 'https://api.deepseek.com',                 hint: 'DeepSeek API (OpenAI-compatible). API key authentication.' }
];

export function providerDef(id) {
  return SETTINGS_PROVIDERS.find(p => p.id === id) || null;
}

export function authNsForProvider(id) {
  if (id === 'openai-compatible') return 'openai';
  return id;
}

// ---- Model recent (server-side, SQLite) -----------------------------

export async function loadRecentModels(projectDir) {
  if (!projectDir) return [];
  const r = await fetchJson('/api/settings/models/recent?projectDir=' + encodeURIComponent(projectDir));
  if (r.status !== 200) return [];
  return Array.isArray(r.body && r.body.recent) ? r.body.recent : [];
}

export async function touchRecentModel(projectDir, provider, modelId) {
  if (!projectDir || !provider || !modelId) return;
  await fetchJson('/api/settings/models/recent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir, provider, modelId })
  });
}

export async function clearRecentModels(projectDir) {
  if (!projectDir) return;
  await fetchJson('/api/settings/models/recent?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' });
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