'use strict';

// Shared state + cross-cutting helpers for the HTTP server.
//
// The original single-file src/index.js (later src/http-server.js) held
// every route handler, the shared in-memory state (SSE clients, running
// chats, access-attempt tracking, the live model cache) and the helpers
// those handlers all reach for (sendJSON, cookie/origin authorization,
// settings redaction, model resolution). This module owns that shared
// surface so the per-domain handler modules stay focused and no file in
// the repo stays above ~2 000 lines.
//
// It deliberately does NOT require any handler module (no circular
// deps); it only requires the domain modules (settings, ai, auth, ...)
// that the helpers delegate to.

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('node:child_process');
const { qs, safeDecode, firstStringValue, errCodeToHttpStatus } = require('./util.js');
const settings = require('./settings.js');
const { connectionType, findConnection, providerTypeOf, hydrateModel } = require('./providerConnections.js');
const projects = require('./projects.js');
const ai = require('./ai.js');
const auth = require('./auth.js');
const accessAuth = require('./access-auth.js');
const qr = require('./qr.js');
const oauthAnthropic = require('./oauth-anthropic.js');
const oauthCopilot = require('./oauth-github-copilot.js');
const oauthOpenRouter = require('./oauth-openrouter.js');
const oauthCodex = require('./oauth-codex.js');

// Register each per-provider exchange function with the auth skeleton.
// Idempotent; safe to call from require-time side effects because
// auth.registerExchange overwrites cleanly. This is the require-time
// registration that used to live at the top of src/index.js (pre-split);
// the refactor that split http-server.js into handler modules dropped it,
// which made every POST /api/auth/sign-in/<provider> return 501
// "<Provider> OAuth is not registered in this build". Without it the
// OAuth sign-in button can never start a flow, loopback or domain-served.
oauthAnthropic.register();
oauthCopilot.register();
oauthOpenRouter.register();
oauthCodex.register();
const chats = require('./chats.js');
const messages = require('./messages.js');
const trace = require('./trace.js');
const inspector = require('./inspector.js');
const inspectorProfiles = require('./inspectorProfiles.js');
const prompts = require('./prompts.js');
const promptProfiles = require('./promptProfiles.js');
const tags = require('./tags.js');
const agentFiles = require('./agentFiles.js');
const agentSkills = require('./agentSkills.js');
const agentFeatures = require('./agentFeatures.js');
const agents = require('./agents.js');
const mcp = require('./mcp.js');
const usage = require('./usage.js');
const push = require('./push.js');
const shellTool = require('./tools/shell.js');
const files = require('./files.js');

const DEFAULT_PORT = 5732;
const SESSION_COOKIE = 'mouaif_session';
const ACCESS_COOKIE = 'mouaif_access';
// The mobile UI lives at frontend/ (repo root, not under src/). Vite
// builds it into frontend/dist/. The server serves that directory at
// the root /; it falls back to the pre-build frontend/ source for the
// dev cycle (no Vite build run yet).
const WEB_DIR = path.join(__dirname, '..', 'frontend');
const WEB_DIST = path.join(WEB_DIR, 'dist');

// ---- Socket + connection tracking --------------------------------------

// Track every open socket so the graceful-restart path can force-close
// keep-alive / SSE connections that would otherwise keep server.close()
// from resolving. Keyed by the socket object; value is always true.
const openSockets = new Set();

function trackSocket(socket) {
  openSockets.add(socket);
  socket.on('close', () => openSockets.delete(socket));
}

function destroyOpenSockets() {
  for (const s of openSockets) {
    try { s.destroy(); } catch (_) { /* best-effort */ }
  }
  openSockets.clear();
}

// Store connected SSE clients
const sseClients = new Set();

// Chats with an in-flight streaming run. handleChatStream registers a
// chat here for the lifetime of its SSE response; GET /api/chats/:id
// surfaces it as a response-only `running` flag so a client that
// reloads mid-run can re-enter its busy/streaming state instead of
// showing the transcript frozen. In-memory (not persisted): a process
// restart ends every run anyway, so nothing survives to clear.
const runningChats = new Set();
const runningChatCancels = new Map();
const accessAttempts = new Map();
const liveChat = require('./live-chat.js');
function runningKey(projectDir, chatId) {
  return String(projectDir) + '::' + String(chatId);
}

// In-memory store for REST demo
const store = { message: 'Hello from mouaif!', timestamp: new Date().toISOString() };

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Settings responses are consumed by the browser, so secrets must never be
// serialized back after they have been stored. The UI only needs to know
// whether a key exists in order to render its masked "key: •••" hint.
function connectionForClient(connection) {
  if (!connection || typeof connection !== 'object') return connection;
  const safe = { ...connection };
  safe.hasApiKey = typeof safe.apiKey === 'string' && safe.apiKey.length > 0;
  delete safe.apiKey;
  return safe;
}

function modelForClient(model) {
  return connectionForClient(model);
}

// The app-level store accumulates server-only bookkeeping that the browser
// has no business seeing: in-flight OAuth flows (`authPending`, which carry a
// PKCE `codeVerifier` and CSRF `state` — real secrets), the CDP debugger URL,
// and anything a future feature stashes there. Rather than blocklist each new
// leak, we allowlist the exact keys the web UI consumes. Everything else is
// dropped before it ever hits the wire.
//
// Both lists are generated from the content registry
// (src/content/registry.js): a key is client-visible when its declaration sets
// `clientVisible`, and resettable when it has a default or sets `resettable`
// (additive keys such as the pricing table, whose absence IS the default, but
// which the UI must still be able to clear). A key that is stored but not
// allowlisted is dropped from every /api/settings response, which looks like a
// toggle that will not save — declare new app settings in the registry.
const contentRegistry = require('./content/registry.js');
const CLIENT_SETTINGS_KEYS = Object.freeze(contentRegistry.clientSettingsKeys());

// Keys that POST /api/settings/app/reset is allowed to drop from the app store.
const RESETTABLE_APP_KEYS = Object.freeze(new Set(contentRegistry.resettableAppKeys()));

// Allowlist projection for the APP-level store only. Project payloads must
// use projectForClient() below — see the note there for why.
function settingsForClient(value) {
if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
const safe = {};
for (const key of CLIENT_SETTINGS_KEYS) {
if (Object.prototype.hasOwnProperty.call(value, key)) safe[key] = value[key];
}
if (Array.isArray(safe.providers)) safe.providers = safe.providers.map(connectionForClient);
if (Array.isArray(safe.models)) safe.models = safe.models.map(modelForClient);
return safe;
}
// Project settings are user-authored and open-ended: `<projectDir>/.mouaif.json`
// is hand-editable and every feature that lands there adds a key (`name`,
// `agents`, `skills`, `agentFiles`, `hideFileContent`, `tags`,
// `customActions`, `totalCost`, ...). Filtering them through the app-level
// allowlist above dropped all of those from the wire, which made the
// Technical-details raw editor incomplete and froze project-scoped UI state
// (e.g. the hidden-file count, the agent-files / skills switches) at its
// default. So project payloads are sent whole and only two things are
// removed: secrets (no project file may carry an `apiKey` — see
// docs/decisions.md §3) and the internal `__dbBacked` storage marker.
function projectForClient(value) {
if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
const safe = { ...value };
delete safe.__dbBacked;
if (Array.isArray(safe.providers)) safe.providers = safe.providers.map(connectionForClient);
if (Array.isArray(safe.models)) safe.models = safe.models.map(modelForClient);
return safe;
}

// ---- SSE ----------------------------------------------------------------

// `filter(event, data)` (optional) limits what one client receives. A shared
// project's terminal uses it: a share caller only gets its own session's
// `cli_output` frames (src/http-server.js → dispatchShareRequest).
function handleSSE(req, res, filter) {
  if (typeof filter === 'function') res.__eventFilter = filter;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'SSE connection established' })}\n\n`);

  sseClients.add(res);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
  });
}

// Broadcast an event to all SSE clients
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (client.__eventFilter) {
      let pass = false;
      try { pass = client.__eventFilter(event, data); } catch { pass = false; }
      if (!pass) continue;
    }
    client.write(payload);
  }
}

// ---- Request authorization helpers -------------------------------------

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function requestOrigin(req) {
  const raw = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (!raw) return '';
  try { return new URL(raw).origin; } catch { return null; }
}

function normalizePublicOrigin(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch { return null; }
}

function expectedOrigin(req, publicOrigin) {
  if (publicOrigin) return publicOrigin;
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
  if (!host || /[\r\n]/.test(host)) return null;
  const protocol = req.socket && req.socket.encrypted ? 'https://' : 'http://';
  try { return new URL(protocol + host).origin; } catch { return null; }
}

function sessionCookie(sessionToken, secure) {
  return SESSION_COOKIE + '=' + sessionToken + '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
}

function accessCookie(token, secure, maxAge) {
  return ACCESS_COOKIE + '=' + (token || '') + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.max(0, Math.floor(maxAge || 0)) + (secure ? '; Secure' : '');
}

function requestHasBrowserOrigin(req) {
  return typeof req.headers.origin === 'string' || typeof req.headers['sec-fetch-site'] === 'string';
}

function authorizeBrowserRequest(req, res, sessionToken, publicOrigin) {
  const origin = requestOrigin(req);
  if (!origin) return true;
  const expected = expectedOrigin(req, publicOrigin);
  if (!expected || origin !== expected) {
    sendJSON(res, 403, { error: 'Cross-origin requests are not allowed', code: 'EORIGIN' });
    return false;
  }
  const cookies = parseCookies(req.headers.cookie);
  const actual = cookies[SESSION_COOKIE] || '';
  const valid = actual.length === sessionToken.length
    && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(sessionToken));
  if (!valid) {
    if (!actual) {
      sendJSON(res, 401, { error: 'Browser session is missing or expired', code: 'ESESSION' });
      return false;
    }
    // A server restart generates a new in-memory browser session token.
    // The already-open mobile UI still has the old HttpOnly cookie and
    // would otherwise get stuck with ESESSION until the user reloads
    // /. Same-origin Origin validation above is the CSRF boundary; for
    // same-origin browser traffic with a stale cookie, mint the fresh cookie
    // and let the request continue.
    res.setHeader('Set-Cookie', sessionCookie(sessionToken, !!expected && expected.startsWith('https://')));
  }
  return true;
}

function authorizeAccessRequest(req, res, authEnabled) {
  if (!authEnabled) return true;
  if (!accessAuth.configured()) {
    // Preserve the existing loopback CLI/API workflow until the user opts in;
    // browser traffic is held at setup so the web UI cannot expose app data.
    if (!requestHasBrowserOrigin(req)) return true;
    sendJSON(res, 401, { error: 'Complete access setup first', code: 'EAUTH_SETUP_REQUIRED' });
    return false;
  }
  const token = parseCookies(req.headers.cookie)[ACCESS_COOKIE] || '';
  if (accessAuth.session(token)) return true;
  // Non-browser CLI/API clients can use standard HTTP Basic auth instead of
  // first creating a cookie session.
  const authorization = String(req.headers.authorization || '');
  if (authorization.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const split = decoded.indexOf(':');
      if (split >= 0 && accessAuth.verifyPassword(decoded.slice(0, split), decoded.slice(split + 1))) return true;
    } catch (_) { /* malformed Basic header falls through to 401 */ }
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="mouaif", charset="UTF-8"');
  const accept = String(req.headers.accept || '');
  if (req.method === 'GET' && accept.includes('text/html')) {
    res.writeHead(302, { Location: '/#/login' });
    res.end();
    return false;
  }
  sendJSON(res, 401, { error: 'Sign in is required', code: 'EAUTH_REQUIRED' });
  return false;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// readJsonOr400(req, res) — readJsonBody with the uniform error guard
// that every POST/PUT/PATCH handler used to repeat inline:
//   try { body = await readJsonBody(req); }
//   catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
// Returns the parsed body, or null after it has already sent a 400
// response. Callers can `const body = await readJsonOr400(req, res); if (!body) return;`
async function readJsonOr400(req, res) {
  try {
    return await readJsonBody(req);
  } catch (e) {
    sendJSON(res, e.status || 400, { error: e.message });
    return null;
  }
}

// ---- AI model resolution ------------------------------------------------

function resolveModel(modelId, projectDir, providerId) {
  if (!modelId || typeof modelId !== 'string') {
    const e = new Error('modelId is required');
    e.code = 'EBADINPUT';
    throw e;
  }
  // A chat of a shared project, used through the mouaif it was added on,
  // runs with that mouaif's providers (docs/features/share-project.md →
  // "Borrowed providers"). The record carries no credential: the provider
  // call is built and signed on the adding side (src/share.js → borrowFetch).
  const shareCaller = require('./share-gate.js').currentCaller();
  if (shareCaller && shareCaller.borrow) {
    return require('./share.js').borrowedModel(modelId, providerId, projectDir, shareCaller);
  }
  const resolved = settings.getResolved(projectDir || null);
  const list = Array.isArray(resolved.models) ? resolved.models : [];
  const wantedProvider = typeof providerId === 'string' ? providerId.trim() : '';
  let m = list.find(x => x && x.id === modelId && (!wantedProvider || x.provider === wantedProvider));
  let liveCatalogModel = false;
  if (!m) {
    // Live catalog entries are intentionally not persisted into the
    // project's optional models array. The browser submits providerId so
    // the server can build the same minimal model record on demand.
    if (wantedProvider && ai.ENDPOINTS[providerTypeOf(wantedProvider)]) {
      m = { id: modelId, provider: wantedProvider };
      liveCatalogModel = true;
    } else {
      const e = new Error('Model not found: ' + modelId);
      e.code = 'EMODEL_NOT_FOUND';
      throw e;
    }
  }
  // Project models contain identity/selection metadata only. The app-level
  // provider connection exclusively owns transport and credentials.
  const connection = findConnection(m.provider);
  if (!connection && liveCatalogModel) {
    const e = new Error('Provider connection not found: ' + m.provider);
    e.code = 'EPROVIDER_NOT_FOUND';
    throw e;
  }

  // Live-catalog models (OpenRouter etc.) carry per-model pricing from the
  // upstream /models list, which the client fetched into MODEL_LIST_CACHE
  // before the user picked the model. Fold that pricing onto the record so
  // the cost line uses the provider's real numbers instead of the
  // best-effort built-in table. Project-level records keep their own
  // `pricing` (most specific) — only the live path is enriched here.
  if (liveCatalogModel && !m.pricing) {
    const cached = MODEL_LIST_CACHE.get(modelListCacheKey(m.provider, credHashFor(m.provider), 'chat', baseUrlForProvider(m.provider)));
    if (cached && Array.isArray(cached.models)) {
      const live = cached.models.find((x) => x && x.id === modelId);
      if (live && live.pricing && typeof live.pricing === 'object') {
        m = Object.assign({}, m, { pricing: live.pricing });
      }
    }
  }

  // Never let committed project JSON redirect a global credential to an
  // attacker-controlled endpoint or replace auth/account/header policy.
  const hydrated = hydrateModel(connection, m);
  if (!hydrated.auth) hydrated.auth = 'apikey';
  return hydrated;
}

// credHashFor(provider) — the same bucket key used by the /api/ai/models/live
// cache. Reuses credentialForProvider so resolveModel and the live endpoint
// agree on which cache entry is current.
function credHashFor(provider) {
  let cred = null;
  try { cred = credentialForProvider(provider); }
  catch { /* listModels will surface ENO_APIKEY if the provider requires a credential */ }
  return cred ? hashShort(cred) : '-';
}

// baseUrlForProvider(provider) — the configured base URL of a provider
// connection, or null when unset. The live model list reads it so an
// openai-compatible connection pointed at a local llama.cpp `llama-server`
// (or LM Studio) lists that server's models instead of the hosted OpenAI
// default. A credential alone cannot distinguish two local servers, so the
// list cache keys include this value (see modelList.js).
function baseUrlForProvider(provider) {
  const conn = findConnection(provider);
  if (!conn || typeof conn.baseUrl !== 'string') return null;
  const trimmed = conn.baseUrl.trim();
  return trimmed.length ? trimmed : null;
}

function credentialForProvider(provider) {
  const conn = findConnection(provider);
  if (!conn) return null;
  if (conn.apiKey) return conn.apiKey;
  if (conn.auth === 'oauth') {
    const token = auth.tokenForModel({ provider: connectionType(conn), auth: 'oauth', oauthAccount: conn.oauthAccount });
    const parsedToken = token ? JSON.parse(token) : null;
    return parsedToken && parsedToken.accessToken ? parsedToken.accessToken : null;
  }
  return null;
}

// In-memory cache for /api/ai/models/live. Keyed by
// `${provider}:${credHash}` so a key rotation invalidates the entry.
// Cleared on process restart; the chat UI also has its own explicit
// "refresh" button that bypasses the cache (via cache-buster).
const MODEL_LIST_CACHE = new Map();
const MODEL_LIST_TTL_MS = 60 * 60 * 1000;       // 1 hour
const MODEL_LIST_TIMEOUT_MS = 8000;            // 8 s

// hashShort(s) — cheap 32-bit FNV-1a. Used to bucket per-credential
// cache entries without leaking the actual key.
function hashShort(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// modelListCacheKey(provider, credHash, purpose) — the cache key for one slice
// of a provider's model list.
//
// The same provider is asked more than one question — the chat catalog and the
// speech-to-text catalog — and the answers must not share an entry: serving
// the chat list to the dictation picker is what made every OpenRouter
// dictation attempt fail with `400 Model … does not exist`. The chat slice
// keeps the two-part key its existing callers (resolveModel, the test seeding
// hook, the live-list route) already use; any other slice appends its name.
function modelListCacheKey(provider, credHash, purpose, baseUrl) {
const p = purpose && purpose !== 'chat' ? ':' + purpose : '';
// A local openai-compatible connection carries no credential, so the base URL
// is the only thing that distinguishes two servers (llama.cpp on :8080 vs
// LM Studio on :1234). Fold it in so switching servers cannot serve the
// previous one's catalog. Hosted providers leave it out (null/empty) to keep
// their existing two-part key.
const b = baseUrl ? ':' + baseUrl : '';
return provider + ':' + credHash + b + p;
}
// seedModelListCache(provider, models) — test-only hook: pre-fill the
// in-memory live model cache so resolveModel can pick up per-model
// pricing without a live upstream call.
function seedModelListCache(provider, models) {
if (provider) MODEL_LIST_CACHE.set(modelListCacheKey(provider, credHashFor(provider), 'chat', baseUrlForProvider(provider)), { models, fetchedAt: Date.now() });
}

// ---- App access authentication helpers ----------------------------------

function accessRequestOrigin(req, publicOrigin) {
  const origin = expectedOrigin(req, publicOrigin);
  if (!origin) throw Object.assign(new Error('Could not determine the app origin'), { code: 'EORIGIN' });
  return origin;
}

function accessAttemptKey(req) {
  return String(req.socket && req.socket.remoteAddress || 'unknown');
}

function checkAccessAttempts(req) {
  const key = accessAttemptKey(req);
  const now = Date.now();
  const recent = (accessAttempts.get(key) || []).filter((at) => now - at < 60_000);
  // Drop the key once its window is empty so every IP that ever probed the
  // login page does not stay in memory for the life of the server.
  if (recent.length) accessAttempts.set(key, recent); else accessAttempts.delete(key);
  return recent.length < 10;
}

function recordAccessFailure(req) {
  const key = accessAttemptKey(req);
  const recent = accessAttempts.get(key) || [];
  recent.push(Date.now());
  accessAttempts.set(key, recent);
}

function clearAccessFailures(req) {
  accessAttempts.delete(accessAttemptKey(req));
}

function publicAccessStatus(authEnabled = true) {
  const account = accessAuth.user();
  return {
    enabled: !!authEnabled,
    configured: !!account,
    user: account ? account.username : null,
    passkeyCount: account ? accessAuth.passkeys().length : 0
  };
}

// ---- OAuth callback helpers --------------------------------------------

function htmlPage(title, body) {
  const safe = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + safe(title) + '</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:24px;max-width:480px}h1{font-size:1.1rem;margin:0 0 12px}p{color:#aaa;margin:0 0 12px}.ok{color:#7bd88f}.err{color:#ff8a8a}</style></head><body><h1>' + safe(title) + '</h1>' + body + '</body></html>';
}

// Return-page snippet for OAuth callback pages so the page gets the user
// back into the app after sign-in completes. Critical on iOS PWA standalone
// mode where there is no tab bar and the user cannot manually "close this
// tab".
//
// When `closePopup` is set (success pages) the JS runs immediately (no 2s
// wait):
//   - popup flow (window.open without noopener): close the popup via
//     window.close(); the opener app polls the account list and reports
//     success itself.
//   - full-page flow (iOS PWA redirect-back): replace the current page
//     with the app so the user lands straight back in the UI.
// Error pages pass no `closePopup`: the instant close would hide the
// failure message before the user could read it, so they keep the plain 2s
// meta refresh instead.
// The meta refresh is a no-JS fallback (identical destination), and a
// manual "Return to the app" link is always available as a tap target.
function redirectMeta(url, closePopup, completion) {
  const safe = String(url).replace(/["<>]/g, '');
  let js = '';
  if (closePopup) {
    js = '<script>'
      + 'try{'
      + 'if(window.opener&&window.opener!==window&&!window.opener.closed){'
      + (completion ? 'window.opener.postMessage(' + JSON.stringify(completion).replace(/</g, '\\u003c') + ',location.origin);' : '')
      + 'window.close();'
      + '}else{'
      + 'location.replace(' + JSON.stringify(safe) + ');'
      + '}'
      + '}catch(e){location.replace(' + JSON.stringify(safe) + ');}'
      + '</script>';
  }
  return '<meta http-equiv="refresh" content="2; url=' + safe + '">'
    + js
    + '<p>Redirecting back to the app… <a href="' + safe + '" style="color:#7bd88f">Return now</a>.</p>';
}

async function finishOAuth({ provider, state, code, errorParam, format }) {
  // If provider wasn't in the URL query, try to extract it from the
  // state prefix. Some OAuth providers (OpenRouter) don't forward
  // query params from the callback_url, so the ?provider=openrouter
  // param is lost. By encoding the provider as a prefix in the state
  // (e.g. "openrouter:<random>"), we recover it.
  if (!provider && typeof state === 'string' && state.includes(':')) {
    const colonIdx = state.indexOf(':');
    const candidate = state.slice(0, colonIdx);
    if (auth.SUPPORTED_PROVIDERS.includes(candidate)) {
      provider = candidate;
    }
  }
  if (!provider || !auth.SUPPORTED_PROVIDERS.includes(provider)) {
    return { status: 400, error: 'Unknown or missing provider', code: 'EBADPROVIDER' };
  }
  if (errorParam) {
    return { status: 400, error: errorParam, code: 'EPROVIDER_ERROR' };
  }
  if (!state || !code) {
    return { status: 400, error: 'Missing state or code', code: 'EBADINPUT' };
  }
  const pending = auth.consumePending(provider, state);
  if (!pending) {
    return { status: 400, error: 'No pending sign-in matches this state. Start the sign-in again from the app.', code: 'ENOPENDING' };
  }
  const exchange = auth.getExchange(provider);
  if (!exchange) {
    return { status: 501, error: 'Sign-in for ' + provider + ' is not configured in this build.', code: 'ENOEXCHANGE' };
  }
  let out;
  try {
    out = await exchange({ pending, code });
  } catch (e) {
    return { status: 500, error: e.message || 'exchange threw', code: e.code || 'EEXCHANGE' };
  }
  if (!out || out.error) {
    return { status: 400, error: (out && out.error) || 'exchange returned no token', code: 'EEXCHANGE' };
  }
  try {
    const blob = JSON.stringify({
      accessToken: out.accessToken,
      refreshToken: out.refreshToken || null,
      expiresAt: out.expiresAt || null,
      scope: out.scope || pending.scopes || null
    });
    const account = out.account || pending.accountHint || 'default';
    await auth.setToken(provider, account, blob);
    return { status: 200, account };
  } catch (e) {
    return { status: 500, error: e.message, code: e.code || 'ECREDENTIALS' };
  }
}

function xyToText(xy) {
  const map = {
    M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied',
    U: 'Unmerged', '?': 'Untracked', '!': 'Ignored', T: 'Type changed'
  };
  return map[xy[1] !== ' ' ? xy[1] : xy[0]] || 'Changed';
}

// firstStringValue() is shared from src/util.js.

module.exports = {
  // constants
  DEFAULT_PORT,
  SESSION_COOKIE,
  ACCESS_COOKIE,
  WEB_DIR,
  WEB_DIST,
  CLIENT_SETTINGS_KEYS,
  RESETTABLE_APP_KEYS,
  MODEL_LIST_TTL_MS,
  MODEL_LIST_TIMEOUT_MS,
  // state
  openSockets,
  sseClients,
  runningChats,
  runningChatCancels,
  accessAttempts,
  liveChat,
  store,
  MODEL_LIST_CACHE,
  modelListCacheKey,
  // domain modules (re-exported so handlers + http-server share one instance)
  settings,
  projects,
  ai,
  auth,
  accessAuth,
  qr,
  oauthAnthropic,
  oauthCopilot,
  oauthOpenRouter,
  chats,
  messages,
  trace,
  inspector,
  inspectorProfiles,
  prompts,
  promptProfiles,
  tags,
  agentFiles,
  agentSkills,
  agentFeatures,
  agents,
  mcp,
  usage,
  push,
  shellTool,
  files,
  // helpers
  trackSocket,
  destroyOpenSockets,
  runningKey,
  sendJSON,
  connectionForClient,
  modelForClient,
  settingsForClient,
  projectForClient,
  handleSSE,
  broadcast,
  parseCookies,
  requestOrigin,
  normalizePublicOrigin,
  expectedOrigin,
  sessionCookie,
  accessCookie,
  requestHasBrowserOrigin,
  authorizeBrowserRequest,
  authorizeAccessRequest,
  readJsonBody,
  readJsonOr400,
  resolveModel,
  credHashFor,
  credentialForProvider,
  baseUrlForProvider,
  hashShort,
  seedModelListCache,
  accessRequestOrigin,
  accessAttemptKey,
  checkAccessAttempts,
  recordAccessFailure,
  clearAccessFailures,
  publicAccessStatus,
  htmlPage,
  redirectMeta,
  finishOAuth,
  xyToText,
  firstStringValue,
  qs,
  safeDecode,
  errCodeToHttpStatus
};
