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
const { qs, safeDecode, projectModelRecord, firstStringValue, errCodeToHttpStatus } = require('./util.js');
const settings = require('./settings.js');
const projects = require('./projects.js');
const ai = require('./ai.js');
const auth = require('./auth.js');
const accessAuth = require('./access-auth.js');
const qr = require('./qr.js');
const oauthAnthropic = require('./oauth-anthropic.js');
const oauthCopilot = require('./oauth-github-copilot.js');
const oauthOpenRouter = require('./oauth-openrouter.js');

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
const chats = require('./chats.js');
const messages = require('./messages.js');
const trace = require('./trace.js');
const inspector = require('./inspector.js');
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

// A redacted settings snapshot contains `hasApiKey`, which is a
// response-only marker. Never persist it if a client round-trips the
// snapshot through a generic patch endpoint. Existing secrets are
// preserved unless the client explicitly submits a new `apiKey`.
// Shared by PUT /api/settings/app and PUT /api/settings/project so the
// redaction contract is symmetric across scopes.
function sanitizeClientEntries(patch, key, existing) {
  if (!patch || !Array.isArray(patch[key])) return;
  const prior = Array.isArray(existing) ? existing : [];
  patch[key] = patch[key].map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const clean = { ...entry };
    delete clean.hasApiKey;
    if (!Object.prototype.hasOwnProperty.call(clean, 'apiKey')) {
      const prev = prior.find(x => x && x.id === clean.id);
      if (prev && typeof prev.apiKey === 'string') clean.apiKey = prev.apiKey;
    }
    return clean;
  });
}

// The app-level store accumulates server-only bookkeeping that the browser
// has no business seeing: in-flight OAuth flows (`authPending`, which carry a
// PKCE `codeVerifier` and CSRF `state` — real secrets), the CDP debugger URL,
// and anything a future feature stashes there. Rather than blocklist each new
// leak, we allowlist the exact keys the web UI consumes. Everything else is
// dropped before it ever hits the wire.
const CLIENT_SETTINGS_KEYS = Object.freeze([
  'providers',      // app-level provider connections (apiKey redacted below)
  'models',         // user-defined models
  'projects',       // registered project cards
  'promptSize',     // default prompt-size profile
'enterForNewline', // composer keyboard default (Enter newline vs send)
'autoRetry',      // auto-retry failed turns before the stream starts
  'prompts',        // app-level custom prompts
  'githubCopilot',  // { clientId } for the custom OAuth app
  'modelPricing',   // per-model cost table
  'authAccounts',   // non-secret OAuth account index
  'tools',          // per-project tool config (e.g. tools.shell.enabled) — non-secret
  'toolFeedbackMaxBytes', // model-facing tool-result byte cap
  'toolOutput',     // per-project tool output profile { size, structure } — non-secret
  'notifications',  // browser notification event preferences
  'flags'           // server-side feature toggles (non-secret)
]);

// Keys that POST /api/settings/app/reset is allowed to drop from the app
// store. The DEFAULTS keys are the baseline; the extras are additive app
// keys that have no in-code default (their absence IS the default) but
// that the UI must still be able to clear — otherwise "reset" silently
// can't reach settings like the custom pricing table.
const RESETTABLE_APP_KEYS = Object.freeze(
  new Set([...Object.keys(settings.DEFAULTS), 'modelPricing', 'githubCopilot'])
);

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

// ---- SSE ----------------------------------------------------------------

function handleSSE(req, res) {
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
  const resolved = settings.getResolved(projectDir || null);
  const list = Array.isArray(resolved.models) ? resolved.models : [];
  const wantedProvider = typeof providerId === 'string' ? providerId.trim() : '';
  let m = list.find(x => x && x.id === modelId && (!wantedProvider || x.provider === wantedProvider));
  let liveCatalogModel = false;
  if (!m) {
    // Live catalog entries are intentionally not persisted into the
    // project's optional models array. The browser submits providerId so
    // the server can build the same minimal model record on demand.
    if (wantedProvider && ai.ENDPOINTS[wantedProvider]) {
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
  const app = settings.getApp();
  const providers = Array.isArray(app.providers) ? app.providers : [];
  const connection = providers.find(p => p && p.id === m.provider);
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
    const cached = MODEL_LIST_CACHE.get(m.provider + ':' + credHashFor(m.provider));
    if (cached && Array.isArray(cached.models)) {
      const live = cached.models.find((x) => x && x.id === modelId);
      if (live && live.pricing && typeof live.pricing === 'object') {
        m = Object.assign({}, m, { pricing: live.pricing });
      }
    }
  }

  // Never let committed project JSON redirect a global credential to an
  // attacker-controlled endpoint or replace auth/account/header policy.
  const safeModel = projectModelRecord(m);

  const hydrated = Object.assign({}, connection || {}, safeModel, { provider: m.provider });
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

function credentialForProvider(provider) {
  const app = settings.getApp();
  const conn = (Array.isArray(app.providers) ? app.providers : []).find((p) => p && p.id === provider);
  if (!conn) return null;
  if (conn.apiKey) return conn.apiKey;
  if (conn.auth === 'oauth') {
    const token = auth.tokenForModel({ provider, auth: 'oauth', oauthAccount: conn.oauthAccount });
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

// seedModelListCache(provider, models) — test-only hook: pre-fill the
// in-memory live model cache so resolveModel can pick up per-model
// pricing without a live upstream call.
function seedModelListCache(provider, models) {
  if (provider) MODEL_LIST_CACHE.set(provider + ':' + credHashFor(provider), { models, fetchedAt: Date.now() });
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
  accessAttempts.set(key, recent);
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
function redirectMeta(url, closePopup) {
  const safe = String(url).replace(/["<>]/g, '');
  let js = '';
  if (closePopup) {
    js = '<script>'
      + 'try{'
      + 'if(window.opener&&window.opener!==window&&!window.opener.closed){'
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
    return { status: 500, error: e.message, code: e.code || 'EKEYRING' };
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
  sanitizeClientEntries,
  settingsForClient,
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
