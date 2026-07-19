const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const settings = require('./settings.js');
const projects = require('./projects.js');
const ai = require('./ai.js');
const auth = require('./auth.js');
const oauthAnthropic = require('./oauth-anthropic.js');
const oauthCopilot = require('./oauth-github-copilot.js');
const oauthOpenRouter = require('./oauth-openrouter.js');
const chats = require('./chats.js');
const messages = require('./messages.js');
const trace = require('./trace.js');
const inspector = require('./inspector.js');
const prompts = require('./prompts.js');
const promptProfiles = require('./promptProfiles.js');
const tags = require('./tags.js');
const mcp = require('./mcp.js');
const usage = require('./usage.js');
const shellTool = require('./tools/shell.js');
const files = require('./files.js');

// Register each per-provider exchange function with the auth
// skeleton. Idempotent; safe to call from require-time side effects
// because auth.registerExchange overwrites cleanly.
oauthAnthropic.register();
oauthCopilot.register();
oauthOpenRouter.register();
// Install the MCP server shutdown handler so SIGINT / SIGTERM /
// `process.exit` tear down every running server child.
mcp.installShutdown();

const DEFAULT_PORT = 5732;
const SESSION_COOKIE = 'mouaif_session';
const WEB_DIR = path.join(__dirname, 'web');
// Vite builds the mobile UI into src/web/dist/. The /web/ route serves
// that directory when it exists; otherwise it falls back to the
// pre-build src/web/ source for the dev cycle (no Vite build run yet).
const WEB_DIST = path.join(WEB_DIR, 'dist');

// Store connected SSE clients
const sseClients = new Set();

// Chats with an in-flight streaming run. handleChatStream registers a
// chat here for the lifetime of its SSE response; GET /api/chats/:id
// surfaces it as a response-only `running` flag so a client that
// reloads mid-run can re-enter its busy/streaming state instead of
// showing the transcript frozen. In-memory (not persisted): a process
// restart ends every run anyway, so nothing survives to clear.
const runningChats = new Set();
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
const CLIENT_SETTINGS_KEYS = Object.freeze([
  'providers',      // app-level provider connections (apiKey redacted below)
  'models',         // user-defined models
  'projects',       // registered project cards
  'promptSize',     // default prompt-size profile
  'githubCopilot',  // { clientId } for the custom OAuth app
  'modelPricing',   // per-model cost table
  'authAccounts',   // non-secret OAuth account index
  'tools',          // per-project tool config (e.g. tools.shell.enabled) — non-secret
  'flags'           // server-side feature toggles (non-secret)
]);

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

function expectedOrigin(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
  if (!host || /[\r\n]/.test(host)) return null;
  try { return new URL('http://' + host).origin; } catch { return null; }
}

function authorizeBrowserRequest(req, res, sessionToken) {
  const origin = requestOrigin(req);
  if (!origin) return true;
  const expected = expectedOrigin(req);
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
    // /web/. Same-origin Origin validation above is the CSRF boundary; for
    // same-origin browser traffic with a stale cookie, mint the fresh cookie
    // and let the request continue.
    res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + sessionToken + '; Path=/; HttpOnly; SameSite=Strict');
  }
  return true;
}

function handleRequest(req, res, activePort = DEFAULT_PORT, sessionToken = '', lifecycle = {}) {
  const parsed = url.parse(req.url, true);
  const urlPath = parsed.pathname;
  const method = req.method;

  // The UI and API are deliberately same-origin. A browser first loads
  // /web/, which receives an HttpOnly SameSite cookie. API/SSE requests
  // carrying an Origin must present that cookie and match Host exactly.
  // Requests without Origin remain available to local CLI clients and tests;
  // the CLI binds to loopback unless the user explicitly opts into a remote
  // host. No Access-Control-Allow-Origin header is emitted.
  if (method === 'OPTIONS') {
    return sendJSON(res, 403, { error: 'Cross-origin preflight is not allowed', code: 'EORIGIN' });
  }
  const browserProtected = urlPath === '/events'
    || urlPath === '/oauth/callback'
    || urlPath.startsWith('/api/');
  if (browserProtected && !authorizeBrowserRequest(req, res, sessionToken)) {
    return;
  }

  // SSE endpoint
  if (urlPath === '/events' && method === 'GET') {
    return handleSSE(req, res);
  }

  // Static /web/ (mobile UI bundle). Prefers the Vite build at
  // src/web/dist/; falls back to src/web/ when the build hasn't run yet
  // (e.g. during development before `npm run build:web`). This lets the
  // repo keep working in either state without breaking.
  if (urlPath === '/web' || urlPath === '/web/') {
    res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + sessionToken + '; Path=/; HttpOnly; SameSite=Strict');
    return serveWebFile(res, 'index.html', { preferDist: true });
  }
  if (urlPath.startsWith('/web/')) {
    return serveWebRequest(res, urlPath.slice('/web/'.length));
  }

  // Browser auto-requests a favicon. Serve the real one now that
  // we've generated a 32x32 PNG (no more 204 stub).
  if (urlPath === '/favicon.ico' && method === 'GET') {
    return serveWebFile(res, 'icons/favicon-32.png', { preferDist: true });
  }

  // Settings API
  if (urlPath.startsWith('/api/settings')) {
    return handleSettings(req, res, parsed);
  }

  // Projects API (folder picker + registered projects)
  if (urlPath.startsWith('/api/projects')) {
    return handleProjects(req, res, parsed);
  }

  // File editor (in-app CodeMirror popup). See handleFileEditor for the
  // contract; dispatched here as a top-level route so /api/file and
  // /api/files are first-class (they do not start with /api/projects).
  if (urlPath === '/api/file' || urlPath === '/api/files') {
    return handleFileEditor(req, res, parsed);
  }

  // AI proxy (server-side call to upstream providers; SSE stream back)
  if (urlPath.startsWith('/api/ai/')) {
    return handleAI(req, res, parsed);
  }

  // Auth API (account list, sign-out, status polling, sign-in)
  if (urlPath.startsWith('/api/auth/')) {
    return handleAuth(req, res, parsed);
  }

  // Usage / pricing (model id list, built-in pricing table).
  // The chat UI never holds pricing data; the cost is computed
  // server-side per the stream and shipped on the `done` event.
  // The only read endpoint the chat UI uses here is /builtin, for
  // the SettingsPricing view's "known model ids" hint.
  if (urlPath === '/api/usage/builtin' && method === 'GET') {
    const table = usage.BUILTIN_PRICING || {};
    return sendJSON(res, 200, {
      ids: Object.keys(table).sort(),
      // Echo the table itself so the Settings view (or any future
      // "I want to see what default prices are" UI) doesn't have to
      // duplicate the data. Pricing values are public — no secrets
      // are exposed here.
      table
    });
  }

  // Prompt-size profiles. Static read-only endpoint that lists the
  // three profiles (very-small | average | extensive) so the chat
  // UI and the Settings view can render a picker without hard-coding
  // the labels or descriptions. The actual profile text is consumed
  // server-side at stream time; only the metadata is exposed here.
  if (urlPath === '/api/prompt-profiles' && method === 'GET') {
    return sendJSON(res, 200, {
      profiles: promptProfiles.listProfiles(),
      default: promptProfiles.DEFAULT_PROFILE
    });
  }

  // OAuth loopback callback (provider redirects here after login)
  if (urlPath === '/oauth/callback' && method === 'GET') {
    return handleOAuthCallback(req, res, parsed);
  }
  // No-browser fallback: the UI POSTs { provider, state, code } and
  // gets a JSON response. Same exchange as the GET path.
  if (urlPath === '/oauth/callback' && method === 'POST') {
    return handleOAuthCallbackPost(req, res, parsed);
  }

  // Chats (per-project chat list). The projectDir is part of the URL so
  // the routes are stable and cacheable; for the common case the
  // mobile UI ships it as a query string. PUT and DELETE carry it in
  // the JSON body.
  if (urlPath === '/api/chats' || urlPath.startsWith('/api/chats/')) {
    return handleChats(req, res, parsed);
  }

  // Prompts (custom per-project prompts)
  if (urlPath === '/api/prompts' || urlPath.startsWith('/api/prompts/')) {
    return handlePrompts(req, res, parsed);
  }

  // Tool Authorization API
  if (urlPath.startsWith('/api/tools/authorization')) {
    return handleToolAuthorization(req, res, parsed);
  }

  // Tools — the native shell tool's direct REST surface (also the
  // /shell composer command). Model-initiated calls run inside the
  // AI client's tool loop and do not hit this endpoint.
  if (urlPath === '/api/tools/shell' || urlPath.startsWith('/api/tools/')) {
    return handleTools(req, res, parsed);
  }

  // MCP (Model Context Protocol) — per-project server registry +
  // lifecycle + tool dispatch. Routes are mounted in handleMcp below.
  if (urlPath === '/api/mcp' || urlPath.startsWith('/api/mcp/')) {
    return handleMcp(req, res, parsed);
  }

  // Server lifecycle — graceful restart. Stops MCP children, closes the
  // listening socket, then exits. When possible the CLI relaunches in-process;
  // otherwise an external supervisor may relaunch after exit code 0.
  if (urlPath === '/api/restart') {
    return handleRestart(req, res, parsed, lifecycle);
  }

  // Inspector — REST surface for the CDP bridge. The WebSocket proxy
  // at /api/inspector/proxy is handled in the server's 'upgrade'
  // event (see createServer below), not here.
  if (urlPath.startsWith('/api/inspector/')) {
    return handleInspector(req, res, parsed);
  }

  // Root opens the mobile UI. Keep the actual static bundle under
  // /web/ so asset URLs and the browser session cookie stay consistent.
  if (urlPath === '/' && method === 'GET') {
    res.writeHead(302, { Location: '/web/' });
    res.end();
    return;
  }

  // REST: GET /data
  if (urlPath === '/data' && method === 'GET') {
    return sendJSON(res, 200, store);
  }

  // REST: POST /data
  if (urlPath === '/data' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsedBody = JSON.parse(body);
        Object.assign(store, parsedBody);
        store.timestamp = new Date().toISOString();
        broadcast('data-update', store);
        sendJSON(res, 200, { ok: true, data: store });
      } catch (e) {
        sendJSON(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // 404
  sendJSON(res, 404, { error: 'Not found' });
}

// ---- Settings API -------------------------------------------------------
// Stable contract for the mobile UI. All bodies are JSON. Project endpoints
// take `projectDir` either as a query string (GET) or JSON body (PUT).

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

async function handleSettings(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // GET /api/settings -> { app, defaults, home }
  if (urlPath === '/api/settings' && method === 'GET') {
    return sendJSON(res, 200, {
      home: settings.MOUAIF_HOME,
      defaults: settingsForClient(settings.DEFAULTS),
      app: settingsForClient(settings.getApp())
    });
  }

  // GET /api/settings/resolved?projectDir=<abs path>
  if (urlPath === '/api/settings/resolved' && method === 'GET') {
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      return sendJSON(res, 200, { resolved: settingsForClient(settings.getResolved(dir)) });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/settings/project?projectDir=<abs path>  -> { project, path }
  // Raw project file (no app merge, no defaults). The UI uses this to
  // show the project-level values separately from the resolved view.
  if (urlPath === '/api/settings/project' && method === 'GET') {
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      return sendJSON(res, 200, {
        project: settingsForClient(settings.getProject(dir)),
        path: settings.getProjectPath(dir)
      });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PUT /api/settings/app  body: { ...patch }   (shallow merge into app store)
  if (urlPath === '/api/settings/app' && method === 'PUT') {
    let patch;
    try { patch = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    try {
      // A redacted settings snapshot contains `hasApiKey`, which is a
      // response-only marker. Never persist it if a client round-trips the
      // snapshot through this generic patch endpoint. Existing secrets are
      // preserved unless the client explicitly submits a new `apiKey`.
      for (const key of ['providers', 'models']) {
        if (!Array.isArray(patch[key])) continue;
        const existing = Array.isArray(settings.getApp()[key]) ? settings.getApp()[key] : [];
        patch[key] = patch[key].map((entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          const clean = { ...entry };
          delete clean.hasApiKey;
          if (!Object.prototype.hasOwnProperty.call(clean, 'apiKey')) {
            const prior = existing.find(x => x && x.id === clean.id);
            if (prior && typeof prior.apiKey === 'string') clean.apiKey = prior.apiKey;
          }
          return clean;
        });
      }
      const next = settings.setApp(patch);
      return sendJSON(res, 200, { app: settingsForClient(next) });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // PUT /api/settings/project  body: { projectDir, ...patch }
  if (urlPath === '/api/settings/project' && method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const { projectDir, unset, ...patch } = body || {};
    if (!projectDir || typeof projectDir !== 'string') {
      return sendJSON(res, 400, { error: 'projectDir is required' });
    }
    try {
      let next = Object.keys(patch).length ? settings.setProject(projectDir, patch) : settings.getProject(projectDir);
      if (Array.isArray(unset) && unset.length) next = settings.unsetProjectKeys(projectDir, unset);
      return sendJSON(res, 200, { project: settingsForClient(next), path: settings.getProjectPath(projectDir) });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // POST /api/settings/app/providers  body: { id, baseUrl?, apiKey?, auth?, oauthAccount? }
  // Provider connections are app-level. Project model records reference
  // them by `provider`, keeping credentials out of project files.
  if (urlPath === '/api/settings/app/providers' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    if (!body || typeof body !== 'object' || typeof body.id !== 'string' || !body.id.trim()) {
      return sendJSON(res, 400, { error: 'id is required' });
    }
    if (!Object.prototype.hasOwnProperty.call(ai.ENDPOINTS, body.id)) {
      return sendJSON(res, 400, { error: 'Unknown provider', id: body.id });
    }
    if (body.auth !== undefined && body.auth !== 'apikey' && body.auth !== 'oauth') {
      return sendJSON(res, 400, { error: 'auth must be "apikey" or "oauth"' });
    }
    if (body.oauthAccount !== undefined && (typeof body.oauthAccount !== 'string' || body.oauthAccount.length > 256)) {
      return sendJSON(res, 400, { error: 'oauthAccount must be a string' });
    }
    const app = settings.getApp();
    const providers = Array.isArray(app.providers) ? app.providers.slice() : [];
    const idx = providers.findIndex(p => p && p.id === body.id);
    const merged = Object.assign({}, idx >= 0 ? providers[idx] : {}, body, { id: body.id.trim() });
    delete merged.hasApiKey;
    if (!Object.prototype.hasOwnProperty.call(body, 'apiKey') && idx >= 0 && providers[idx].apiKey) {
      merged.apiKey = providers[idx].apiKey;
    }
    if (merged.auth === 'oauth') delete merged.apiKey;
    if (idx >= 0) providers[idx] = merged; else providers.push(merged);
    try {
      const next = settings.setApp({ providers });
      return sendJSON(res, 200, {
        provider: connectionForClient(merged),
        providers: next.providers.map(connectionForClient)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // DELETE /api/settings/app/providers/:id
  const delProviderMatch = urlPath.match(/^\/api\/settings\/app\/providers\/([A-Za-z0-9._-]+)$/);
  if (delProviderMatch && method === 'DELETE') {
    const id = delProviderMatch[1];
    const app = settings.getApp();
    const providers = Array.isArray(app.providers) ? app.providers.slice() : [];
    const idx = providers.findIndex(p => p && p.id === id);
    if (idx < 0) return sendJSON(res, 404, { error: 'Provider not found', id });
    const [removed] = providers.splice(idx, 1);
    try {
      settings.setApp({ providers });
      return sendJSON(res, 200, {
        ok: true,
        removed: connectionForClient(removed),
        providers: providers.map(connectionForClient)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // Legacy compatibility: app-level model CRUD is retained for older
  // clients. New clients configure providers globally and models per project.
  // POST /api/settings/app/models  body: { ...model }
  // Adds a model to the app-level models array, or merges into an
  // existing entry with the same id. `id` is required; `provider` is
  // required on add but optional on re-add (the existing entry is the
  // source of truth for that field). Returns the merged model and the
  // updated models array.
  if (urlPath === '/api/settings/app/models' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    if (!body || typeof body !== 'object' || !body.id || typeof body.id !== 'string') {
      return sendJSON(res, 400, { error: 'id is required' });
    }
    // Light validation: auth enum, oauthAccount shape, and a sanity
    // check that OAuth models don't carry a stale apiKey. We don't
    // enforce provider↔auth combos here (e.g. anthropic + oauth is
    // valid, openai-compatible + apikey is valid); that's the AI
    // client's job at request time.
    if (body.auth !== undefined && body.auth !== 'apikey' && body.auth !== 'oauth') {
      return sendJSON(res, 400, { error: 'auth must be "apikey" or "oauth"' });
    }
    if (body.oauthAccount !== undefined && (typeof body.oauthAccount !== 'string' || body.oauthAccount.length > 256)) {
      return sendJSON(res, 400, { error: 'oauthAccount must be a string' });
    }
    if (body.auth === 'oauth' && body.apiKey) {
      // OAuth models must not carry a leftover apiKey from a previous
      // apikey-mode entry. Drop it on merge rather than 400 — the user
      // may have toggled auth modes and forgotten to clear the key.
      delete body.apiKey;
    }
    const app = settings.getApp();
    const models = Array.isArray(app.models) ? app.models.slice() : [];
    const idx = models.findIndex(m => m && m.id === body.id);
    if (idx < 0 && !body.provider) {
      return sendJSON(res, 400, { error: 'provider is required when adding a new model' });
    }
    const merged = Object.assign({}, idx >= 0 ? models[idx] : {}, body);
    // Same dedup for the merged result (an existing apikey record
    // toggled to oauth would still carry apiKey from the prior entry).
    if (merged.auth === 'oauth') delete merged.apiKey;
    if (idx >= 0) models[idx] = merged; else models.push(merged);
    try {
      const next = settings.setApp({ models });
      return sendJSON(res, 200, {
        model: modelForClient(merged),
        models: next.models.map(modelForClient)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // DELETE /api/settings/app/models/:id  -> { ok, removed, models }
  const delModelMatch = urlPath.match(/^\/api\/settings\/app\/models\/([A-Za-z0-9._-]+)$/);
  if (delModelMatch && method === 'DELETE') {
    const id = delModelMatch[1];
    const app = settings.getApp();
    const models = Array.isArray(app.models) ? app.models.slice() : [];
    const idx = models.findIndex(m => m && m.id === id);
    if (idx < 0) return sendJSON(res, 404, { error: 'Model not found', id });
    const [removed] = models.splice(idx, 1);
    try {
      settings.setApp({ models });
      return sendJSON(res, 200, {
        ok: true,
        removed: modelForClient(removed),
        models: models.map(modelForClient)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // POST /api/settings/app/reset  body: { keys: ['models', 'flags'] }
  // Clears the listed app-level keys, restoring them to defaults.
  // Implementation: build a fresh patch that contains only the keys
  // NOT in the reset list. setApp shallow-merges, so omitting a key
  // from the patch is a no-op — we need a stronger reset, so we
  // explicitly delete the keys from a clone of the current app and
  // write that clone back.
  if (urlPath === '/api/settings/app/reset' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const keys = Array.isArray(body && body.keys) ? body.keys : [];
    const allowed = new Set(Object.keys(settings.DEFAULTS));
    const bad = keys.filter(k => !allowed.has(k));
    if (bad.length) return sendJSON(res, 400, { error: 'Unknown key(s)', bad });
    // Build a fresh object that omits the reset keys, then write it
    // through. SQLite stores the new object verbatim (setApp uses
    // { ...current, ...patch } internally; here we pass a patch that
    // does NOT include the reset keys, but the merged result still
    // contains them because the stored `current` does). So we need a
    // explicit delete: a special-cased "replace" path. The simplest
    // correct approach is to use the app store's underlying SQL: an
    // UPSERT of an object that has the keys removed.
    const current = settings.getApp();
    const next = Object.assign({}, current);
    for (const k of keys) delete next[k];
    try {
      // setApp is shallow-merge; passing the trimmed object and using
      // a direct write would be ideal, but we don't expose a
      // replace-at-the-root method. Cheapest correct option: pass an
      // empty patch alongside a sentinel, OR just deep-copy the app
      // and write the trimmed version through a new method.
      // -> we add setAppReplace for this.
      const result = settings.setAppReplace(next);
      return sendJSON(res, 200, { app: settingsForClient(result), reset: keys });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'settings' });
}

// ---- Projects API -------------------------------------------------------
// Stable contract for the mobile UI. Two surfaces:
//
//   Filesystem picker (the new-project folder list):
//     GET  /api/projects?dir=<abs>     -> { dir, entries: [{ name, path, hasChildren }] }
//     POST /api/projects  body: { action: "list",   dir: "<abs>" }
//     POST /api/projects  body: { action: "create", parent: "<abs>", name: "<name>" }
//
//   Registered projects (the user's chosen projects):
//     GET    /api/projects/registered                          -> { projects: [...] }
//     POST   /api/projects  body: { action: "register", dir: "<abs>" }
//     DELETE /api/projects/registered/:id                       -> { ok: true }
//
// All paths must be under the user home unless MOUAIF_ALLOW_ANY_ROOT=1.

function projectsErrorStatus(err) {
  switch (err && err.code) {
    case 'EBADPATH':       return 400;
    case 'EOUTSIDE_HOME':  return 403;
    case 'ENOENT':         return 404;
    case 'ENOTDIR':        return 400;
    case 'EACCES':         return 403;
    case 'EEXIST':         return 409;
    case 'EREAD':          return 500;
    default:               return 400;
  }
}

// ---- Chats API --------------------------------------------------------
// Per-project chat list. All routes need a projectDir (query string
// for GET/DELETE, JSON body for POST/PATCH). The chat itself is
// identified by a short hex id generated at creation time.
//
// Endpoints:
//   GET    /api/chats?projectDir=<abs>[&offset=0&limit=20]
//          -> { chats: [..., totalCost: { total, known, currency }], total, offset, limit, projectTotalCost }
//   GET    /api/chats/:id?projectDir=<abs>      -> { chat } | 404
//   POST   /api/chats                            { projectDir, title?, trace?, promptSize? }
//   PATCH  /api/chats/:id                        { projectDir, title?, trace?, promptSize?, draft? }
//   POST   /api/chats/:id/touch                  { projectDir }      (bumps lastOpenedAt)
//   DELETE /api/chats/:id?projectDir=<abs>      -> { ok, removed }

async function handleChats(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  function chatError(e) {
    if (e && e.code === 'MOUAIF_PROJECT_PARSE_ERROR') return 422;
    if (e && e.code === 'EBADINPUT') return 400;
    return 500;
  }

  function readProjectDir(body) {
    const fromQuery = typeof q.projectDir === 'string' ? q.projectDir : '';
    const fromBody = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    const dir = fromQuery || fromBody;
    if (!dir) return null;
    return dir;
  }

  // GET /api/chats?projectDir=<abs>[&offset=0&limit=20]
  if (urlPath === '/api/chats' && method === 'GET') {
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    const offset = Math.max(0, parseInt(typeof q.offset === 'string' ? q.offset : '0', 10) || 0);
    const limitRaw = parseInt(typeof q.limit === 'string' ? q.limit : '0', 10) || 0;
    const limit = limitRaw > 0 ? Math.min(limitRaw, 100) : 0;
    try {
      const list = chats.listChats(dir);
      list.sort((a, b) => {
        const aT = a.lastOpenedAt || a.createdAt || '';
        const bT = b.lastOpenedAt || b.createdAt || '';
        if (aT === bT) return 0;
        return aT < bT ? 1 : -1;
      });
      const page = limit > 0 ? list.slice(offset, offset + limit) : list;
      // Enrich every returned chat with a `totalCost` block so the
      // mobile chat list can render a cost summary in place of the
      // old prompt-size label (decision §14). The project-level cost
      // is still computed from the full list so pagination does not
      // make the project header total drift as the user scrolls.
      let app;
      try { app = settings.getApp(); } catch { app = null; }
      let total = 0;
      let hasKnown = false;
      const pageIds = new Set(page.map((c) => c.id));
      for (const c of list) {
        let totalCost;
        try { totalCost = chats.chatTotalCost(dir, c.id, app); }
        catch { totalCost = { total: 0, known: false, currency: 'USD' }; }
        if (pageIds.has(c.id)) {
          c.totalCost = totalCost;
          // Response-only liveness marker (never persisted), same
          // contract as GET /api/chats/:id, so the project-card
          // chat list can show which chats have a run in flight.
          if (runningChats.has(runningKey(dir, c.id))) c.running = true;
        }
        if (totalCost.known && typeof totalCost.total === 'number') {
          total += totalCost.total;
          hasKnown = true;
        }
      }
      return sendJSON(res, 200, {
        chats: page,
        total: list.length,
        offset,
        limit: limit || list.length,
        projectTotalCost: { total, known: hasKnown, currency: 'USD' }
      });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/chats/:id?projectDir=<abs>
  let m = urlPath.match(/^\/api\/chats\/([^/]+)$/);
  if (m && method === 'GET') {
    const id = decodeURIComponent(m[1]);
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      const chat = chats.getChat(dir, id);
      if (!chat) return sendJSON(res, 404, { error: 'Chat not found', id });
      // Response-only liveness marker (never persisted on the record).
      if (runningChats.has(runningKey(dir, id))) chat.running = true;
      return sendJSON(res, 200, { chat });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/chats   body: { projectDir, title?, trace?, promptSize? }
  if (urlPath === '/api/chats' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = readProjectDir(body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      const chat = chats.createChat(dir, body || {});
      return sendJSON(res, 201, { chat });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PATCH /api/chats/:id   body: { projectDir, title?, trace?, promptSize?, draft? }
  m = urlPath.match(/^\/api\/chats\/([^/]+)$/);
  if (m && method === 'PATCH') {
    const id = decodeURIComponent(m[1]);
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = readProjectDir(body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    // Strip server-owned fields from the client patch. The generic
    // merge in updateChat absorbs every key, so without this a PATCH
    // could rewrite the chat's id, createdAt, or lastOpenedAt.
    // Internal callers (touchChat, titleChatFromPrompt) set those
    // fields intentionally and don't come through here.
    const safeBody = Object.assign({}, body || {});
    delete safeBody.id;
    delete safeBody.createdAt;
    delete safeBody.lastOpenedAt;
    try {
      const chat = chats.updateChat(dir, id, safeBody);
      if (!chat) return sendJSON(res, 404, { error: 'Chat not found', id });
      return sendJSON(res, 200, { chat });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/chats/:id/touch   body: { projectDir }
  m = urlPath.match(/^\/api\/chats\/([^/]+)\/touch$/);
  if (m && method === 'POST') {
    const id = decodeURIComponent(m[1]);
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = readProjectDir(body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      require('./tools/authorization.js').clearGrants(dir, id);
      const chat = chats.touchChat(dir, id);
      if (!chat) return sendJSON(res, 404, { error: 'Chat not found', id });
      return sendJSON(res, 200, { chat });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // DELETE /api/chats/:id?projectDir=<abs>
  m = urlPath.match(/^\/api\/chats\/([^/]+)$/);
  if (m && method === 'DELETE') {
    const id = decodeURIComponent(m[1]);
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      const removed = chats.deleteChat(dir, id);
      if (!removed) return sendJSON(res, 404, { error: 'Chat not found', id });
      // Chat storage and trace export are independent. Deleting a chat
      // removes its transcript, but deliberately keeps the user-owned trace
      // file so it can remain committed with the project (decision §5).
      try { fs.rmSync(messages.messagesFilePath(dir, id), { force: true }); }
      catch { /* best-effort cleanup after the chat record is gone */ }
      return sendJSON(res, 200, { ok: true, removed: id });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // ---- Per-chat messages -------------------------------------------
  // GET /api/chats/:id/messages?projectDir= -> { messages }
  const getMsgsMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (getMsgsMatch && method === 'GET') {
    const id = decodeURIComponent(getMsgsMatch[1]);
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      if (!chats.getChat(dir, id)) return sendJSON(res, 404, { error: 'Chat not found', id });
      return sendJSON(res, 200, { messages: messages.listMessages(dir, id) });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/chats/:id/system-prompt?projectDir= -> { profile, prompt, text }
  // Returns the effective system context for a chat as it will be sent
  // upstream: the resolved prompt-size profile system message and, if
  // the chat references a custom prompt, that prompt's content. The
  // chat UI renders this as the first (collapsible) message in the
  // transcript so the user can see what the model is being told,
  // without the prompt-size picker having to be a permanent fixture.
  const sysPromptMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/system-prompt$/);
  if (sysPromptMatch && method === 'GET') {
    const id = decodeURIComponent(sysPromptMatch[1]);
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      const chat = chats.getChat(dir, id);
      if (!chat) return sendJSON(res, 404, { error: 'chat not found' });
      let profile = null;
      try {
        const p = promptProfiles.resolveProfile({ chat, projectDir: dir });
        if (p) profile = { id: p.id, label: p.label, description: p.description, systemMessage: p.systemMessage };
      } catch { /* profile stays null; the stream would fall through too */ }
      let prompt = null;
      if (chat.promptId) {
        try {
          const cp = prompts.getPrompt(dir, chat.promptId);
          if (cp) prompt = { id: cp.id, title: cp.title, role: cp.role, content: cp.content };
        } catch { /* custom prompt stays null */ }
      }
      // The combined text mirrors the order handleChatStream uses:
      // profile system message first, then the custom prompt.
      const parts = [];
      if (profile && profile.systemMessage) parts.push(profile.systemMessage);
      if (prompt && prompt.content) parts.push(prompt.content);
      return sendJSON(res, 200, { profile, prompt, text: parts.join('\n\n') });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/chats/:id/tool-preview?projectDir= -> { profile, tools }
  // Returns the tool-declaration state for the chat's resolved
  // prompt-size profile: which tools are advertised to the model and
  // in what shape (full spec vs. the very-small discover_tool flow).
  // The chat UI shows this as a temporary preview while
  // the chat is still empty, so the user sees the concrete effect of
  // the S/M/L switch on the tool budget before the first message.
  // The collection logic mirrors ai.streamChat (native shell + MCP),
  // then promptProfiles.reduceToolSpecs applies the same reduction the
  // stream will apply — so the preview is always what the model gets.
  const toolPreviewMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/tool-preview$/);
  if (toolPreviewMatch && method === 'GET') {
    const id = decodeURIComponent(toolPreviewMatch[1]);
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      const chat = chats.getChat(dir, id);
      if (!chat) return sendJSON(res, 404, { error: 'chat not found' });
      // Resolve the profile id (chat -> project -> app -> 'average').
      let profileId = promptProfiles.DEFAULT_PROFILE;
      try {
        const p = promptProfiles.resolveProfile({ chat, projectDir: dir });
        if (p && p.id) profileId = p.id;
      } catch { /* fall through to default */ }
      // Collect the tool specs exactly as streamChat does: base shell,
      // subagent, ask_user, and file tools are always advertised, plus
      // ready MCP servers.
      const shellEnabled = true;
      const fileToolsEnabled = true;
      const toolSpecs = [];
      if (shellEnabled) {
        try { toolSpecs.push(shellTool.SPEC); } catch { /* skip */ }
      }
      try { toolSpecs.push(require('./tools/subagent.js').SPEC); } catch { /* skip */ }
      try { toolSpecs.push(require('./tools/ask.js').SPEC); } catch { /* skip */ }
      if (fileToolsEnabled) {
        try {
          const fileTools = require('./tools/files.js');
          for (const n of fileTools.FILE_TOOL_NAMES) toolSpecs.push(fileTools.SPECS[n]);
        } catch { /* skip */ }
      }
      try {
        const specs = mcp.listComposedToolSpecs(dir);
        if (specs && specs.length) {
          for (const s of specs) {
            toolSpecs.push({
              type: 'function',
              function: { name: s.name, description: s.description, parameters: s.parameters }
            });
          }
        }
      } catch { /* no MCP tools */ }
      // Apply the same initial per-profile reduction the stream applies.
      // For very-small, this starts with discover_tool only; discovered
      // tool schemas are added dynamically during the tool loop.
      let effective = toolSpecs;
      try { effective = promptProfiles.reduceToolSpecs(toolSpecs, profileId); } catch { /* full specs */ }
      const reduced = profileId === 'very-small';
      const tools = (effective || []).map((s) => {
        const fn = (s && s.function) || {};
        const params = fn.parameters && fn.parameters.properties ? Object.keys(fn.parameters.properties) : [];
        return {
          name: fn.name || '',
          description: typeof fn.description === 'string' ? fn.description : '',
          // hasSchema reflects whether this advertised tool exposes
          // parameter names. For very-small's initial preview this is
          // discover_tool's own schema.
          hasSchema: params.length > 0,
          params
        };
      });
      return sendJSON(res, 200, {
        profile: profileId,
        reduced,
        shellEnabled,
        fileToolsEnabled,
        count: tools.length,
        tools
      });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/chats/:id/messages  body: { projectDir, role, content }
  // Append a message directly. The /messages/stream endpoint below
  // does the same internally for user / assistant messages; this
  // route is for manual edits and tests.
  if (getMsgsMatch && method === 'POST') {
    const id = decodeURIComponent(getMsgsMatch[1]);
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      if (!chats.getChat(dir, id)) return sendJSON(res, 404, { error: 'Chat not found', id });
      const msg = messages.appendMessage(dir, id, { role: body.role, content: body.content, ts: body.ts });
      return sendJSON(res, 201, { message: msg });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // DELETE /api/chats/:id/messages?projectDir= -> { ok, removed }
  if (getMsgsMatch && method === 'DELETE') {
    const id = decodeURIComponent(getMsgsMatch[1]);
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      if (!chats.getChat(dir, id)) return sendJSON(res, 404, { error: 'Chat not found', id });
      const removed = messages.clearMessages(dir, id);
      return sendJSON(res, 200, { ok: true, removed });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  const exportTraceMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/trace\/export$/);
  if (exportTraceMatch && method === 'POST') {
    const id = decodeURIComponent(exportTraceMatch[1]);
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      if (!chats.getChat(dir, id)) return sendJSON(res, 404, { error: 'Chat not found', id });
      const file = trace.exportMessages(dir, id, messages.listMessages(dir, id));
      return sendJSON(res, 200, { ok: true, path: file });
    } catch (e) {
      return sendJSON(res, e.code === 'EBADINPUT' ? 400 : 500, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/chats/:id/messages/stream  body: { projectDir, modelId, content }
  // Appends the user message, calls ai.streamChat, streams the
  // response back as SSE, appends the assistant message on done, and
  // writes both events to the trace file (if the chat's trace flag
  // is on). One round-trip per user turn.
  const streamMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/messages\/stream$/);
  if (streamMatch && method === 'POST') {
    return handleChatStream(req, res, streamMatch[1]);
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'chats' });
}

// Handles POST /api/chats/:id/messages/stream. Splits out for clarity;
// the route table above stays compact.
async function handleChatStream(req, res, chatId) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
  const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
  const modelId = body && typeof body.modelId === 'string' ? body.modelId : '';
  const providerId = body && typeof body.providerId === 'string' ? body.providerId : '';
  const content = body && typeof body.content === 'string' ? body.content : '';
  const attachments = messages.normalizeAttachments(body && body.attachments);
  if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
  if (!modelId) return sendJSON(res, 400, { error: 'modelId is required' });
  if (!content && !attachments.length) return sendJSON(res, 400, { error: 'content or image is required' });

  let chat;
  try { chat = chats.getChat(projectDir, chatId); }
  catch (e) {
    const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
    return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
  }
  if (!chat) return sendJSON(res, 404, { error: 'Chat not found', id: chatId });

  // Reject a second concurrent stream on the same chat. Two in-flight
  // runs interleave appendMessage read-modify-writes and both append
  // assistant messages, corrupting transcript order.
  const runKey = runningKey(projectDir, chatId);
  if (runningChats.has(runKey)) {
    return sendJSON(res, 409, { error: 'A response is already streaming for this chat', code: 'EALREADY_RUNNING', id: chatId });
  }

  // Resolve the project model and hydrate it with its app-level provider
  // connection (credentials, base URL, and auth account).
  let model;
  try { model = resolveModel(modelId, projectDir, providerId); }
  catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code, modelId, providerId: providerId || undefined }); }

  // Append the user message and bump lastOpenedAt BEFORE streaming.
  // If this is the first prompt in a new/default-named chat, also
  // derive a human title from that prompt and persist it immediately.
  let userMsg;
  try { userMsg = messages.appendMessage(projectDir, chatId, { role: 'user', content, attachments }); }
  catch (e) { return sendJSON(res, 400, { error: e.message }); }
  try {
    const history = messages.listMessages(projectDir, chatId);
    if (history.filter(m => m && m.role === 'user').length === 1 && content) {
      const renamed = chats.titleChatFromPrompt(projectDir, chatId, content);
      if (renamed) chat = renamed;
    }
  } catch { /* non-fatal */ }
  try { chats.touchChat(projectDir, chatId); } catch { /* non-fatal */ }

  // Mark the chat as running for the lifetime of the SSE response so a
  // reloaded client re-enters its busy state and a second stream is
  // rejected (above). Registered only after every failable setup step
  // (model resolution, message append) so an early 4xx cannot leak the
  // marker; cleared at every exit below (normal, error, and throw).
  runningChats.add(runKey);

  // Open SSE.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(': connected\n\n');

  // Open the trace file. No-op writer if trace is off or the file
  // system is read-only.
  const traceStream = chat.trace ? trace.open(projectDir, chatId) : null;
  function emit(name, data) {
    try {
      res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n');
    } catch { /* socket closed */ }
    if (traceStream) trace.write(traceStream, name, data);
  }
  if (traceStream) {
    const event = trace.eventForMessage(userMsg);
    trace.write(traceStream, event.type, event.payload);
  }

  // Build the message list to send upstream: existing transcript + the
  // user message we just appended. The list is composed in this order
  // (each block is optional, but the profile block is always present):
  //   1. Prompt-size profile system message (decisions §4 prompt-size
  //      profiles). Resolved from chat.promptSize -> resolved project
  //      settings.promptSize -> 'average'. The profile carries the
  //      model identity + the default guidance. A missing or unknown
  //      value falls through to the default; this code never throws.
  //   2. Custom prompt (chat.promptId), if the chat references a
  //      project prompt. The custom prompt refines the profile — the
  //      instructions on each prompt say "where they do not conflict
  //      with the active profile".
  //   3. The transcript (user + assistant turns), with the brand-new
  //      user turn already appended by the appendMessage call above.
  const history = messages.listMessages(projectDir, chatId);
  const upstreamMessages = [];
  // Resolve the prompt-size profile once. Its id drives BOTH the system
  // message (below) and the tool-declaration reduction passed to
  // streamChat (decisions §4: very-small trims tool schemas).
  let resolvedProfileId = promptProfiles.DEFAULT_PROFILE;
  try {
    const profile = promptProfiles.resolveProfile({ chat, projectDir });
    if (profile) {
      if (profile.id) resolvedProfileId = profile.id;
      if (profile.systemMessage) {
        upstreamMessages.push({ role: 'system', content: profile.systemMessage });
      }
    }
  } catch { /* non-fatal; stream proceeds without a profile system message */ }
  // Tagged files (decisions §15). Injected after the profile but before
  // the custom prompt and the transcript, so they are the deepest
  // context. includeInChat entries ride as `system`; any file the user
  // @-referenced in this turn's message is promoted to `user`. A trace
  // line records what was injected without re-reading disk on replay.
  try {
    const referencedPaths = tags.parseReferences(projectDir, content);
    const injected = tags.resolveForInjection(projectDir, { referencedPaths });
    if (injected.length) {
      for (const m of injected) upstreamMessages.push({ role: m.role, content: m.content });
      if (traceStream) {
        trace.write(traceStream, 'tags', {
          files: injected.map(m => ({ path: m.relPath, role: m.role }))
        });
      }
    }
  } catch { /* non-fatal; stream proceeds without tagged files */ }
  if (chat.promptId) {
    try {
      const prompt = prompts.getPrompt(projectDir, chat.promptId);
      if (prompt && prompt.content) {
        upstreamMessages.push({ role: prompt.role, content: prompt.content });
      }
    } catch { /* non-fatal; stream proceeds without the prompt */ }
  }
  function upstreamContentForMessage(m) {
    if (!m || m.role !== 'user' || !Array.isArray(m.attachments) || !m.attachments.length) return m && m.content;
    const parts = [];
    if (m.content) parts.push({ type: 'text', text: m.content });
    for (const a of m.attachments) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    return parts;
  }

  // Reconstruct only complete historical tool call/result pairs. An aborted
  // run can leave a persisted call with no result; strict OpenAI-compatible
  // providers reject that orphan on the next send with HTTP 400. The helper
  // also canonicalizes provider-specific call ids for cross-model resumes.
  const supportsOpenAIToolHistory = model.provider === 'openai-compatible'
    || model.provider === 'openrouter'
    || model.provider === 'github-copilot';
  upstreamMessages.push(...messages.reconstructUpstreamHistory(history, upstreamContentForMessage, {
    includeTools: supportsOpenAIToolHistory
  }));

  let assistantContent = '';
  let assistantReasoning = '';
  let assistantMsg = null;
  // Track the streaming window so the cost line (which is computed
  // server-side from the upstream's authoritative usage block) also
  // carries the streamingMs the chat UI needs for its tok/s counter.
  // (The chat UI independently tracks its own counter for live
  // updates; the server-side number is the fallback when the client
  // missed frames — e.g. when the tab was backgrounded.)
  //
  // streamingMs accumulates ONLY the assistant-streaming windows, not
  // the tool-execution gaps between them. The multi-round tool loop
  // would otherwise stretch the window and under-report tok/s.
  let streamStartedAt = 0;   // set on first message/reasoning delta
  let streamingMs = 0;       // accumulated across streaming windows
  // Per-round usage snapshots from ai.js. Each tool round's upstream
  // call reports its own prompt/completion tokens. When a round ends
  // with tool calls, the pending snapshot is attached to the segment
  // persisted at `assistant_turn_end`, giving it a cost. When the
  // turn ends without tool calls, the snapshot is redundant — the
  // `done` handler computes the final cost from aggregated usage.
  let pendingRoundUsage = null;
  // Per-turn enrichment (cost + usage) is computed once on `done`
  // and reused for both the SSE emit and the persisted assistant
  // message. The chat UI's own live counter and the cost line
  // diverge slightly while the stream is in flight (the live counter
  // is per-delta; the cost line is final); that's intentional.
  let lastEnrichment = null;

  // Compute the cost for an intermediate segment from its round's
  // usage snapshot. Returns null when pricing is unavailable.
  function computeSegmentCost(roundUsage) {
    if (!roundUsage) return null;
    try {
      const app = settings.getApp();
      if (typeof roundUsage.providerCost === 'number' && isFinite(roundUsage.providerCost) && roundUsage.providerCost >= 0) {
        // OpenRouter reports a real input/output split under
        // cost_details; fall back to 0 when the round didn't carry it.
        const split = (v) => (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
        return {
          known: true,
          input: split(roundUsage.providerCostInput),
          output: split(roundUsage.providerCostOutput),
          total: roundUsage.providerCost,
          currency: 'USD'
        };
      }
      const result = usage.computeCost({ model, usage: roundUsage, app });
      return { known: result.known, input: result.input, output: result.output, total: result.total, currency: result.currency };
    } catch { return null; }
  }

  // Built-in shell and file tools are always advertised. Their authorization
  // modes decide whether calls prompt, run automatically, or are disabled.
  const shellEnabled = true;
  const fileToolsEnabled = true;

  // App-level knobs (size caps etc.) are read once and passed through
  // to the file tool dispatcher. The dispatcher itself uses the
  // DEFAULT_* constants when these are missing, so passing the whole
  // app object is fine — only the file-tool keys are consulted.
  let appSettings = {};
  try { appSettings = settings.getApp() || {}; } catch { /* defaults apply */ }

  let result;
  try {
    result = await ai.streamChat({
    model,
    messages: upstreamMessages,
    projectDir,
    chatId, // Pass chatId for authorization gate
    shellEnabled,
    fileToolsEnabled,
    appSettings,
    promptSize: resolvedProfileId,
    // Per-chat tool filter (decisions: chat.tools). null/undefined
    // means "all tools available to the project"; an array (even an
    // empty one) means "restrict to exactly these tool names". The
    // legacy fields above stay so existing API clients keep working.
    enabledTools: chat.tools === null ? null : (Array.isArray(chat.tools) ? chat.tools : null),
    // Per-round usage snapshot (one per upstream API call, including
    // tool rounds). Stashed so `assistant_turn_end` can attach cost
    // to the intermediate segment it persists.
    onRoundUsage: (roundUsage) => { pendingRoundUsage = roundUsage; },
    onEvent: (name, data) => {
      if (name === 'message' && typeof data.delta === 'string') {
        if (!streamStartedAt) streamStartedAt = Date.now();
        assistantContent += data.delta;
        try { res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch { /* socket closed */ }
        return;
      } else if (name === 'reasoning' && typeof data.delta === 'string') {
        if (!streamStartedAt) streamStartedAt = Date.now();
        assistantReasoning += data.delta;
        try { res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch { /* socket closed */ }
        return;
      } else if (name === 'assistant_turn_end') {
        // A tool round is starting: fold the window that just ended into
        // the accumulator and clear the start marker. The next assistant
        // delta re-arms streamStartedAt.
        if (streamStartedAt) { streamingMs += Date.now() - streamStartedAt; streamStartedAt = 0; }
        // Persist text produced before a tool call at its real transcript
        // position, then start a fresh segment for the post-tool response.
        // Attach the round's usage/cost so this segment shows its own
        // cost line in the chat UI.
        // The same numbers ride the SSE event so the live bubble can
        // render the round's real cost without waiting for reconciliation.
        let segmentCost = null;
        let segmentUsage;
        if (assistantContent || assistantReasoning) {
          try {
            segmentCost = computeSegmentCost(pendingRoundUsage);
            segmentUsage = pendingRoundUsage
              ? { promptTokens: pendingRoundUsage.promptTokens, completionTokens: pendingRoundUsage.completionTokens }
              : undefined;
            assistantMsg = messages.appendMessage(projectDir, chatId, {
              role: 'assistant', content: assistantContent, reasoning: assistantReasoning, modelId: model.id,
              usage: segmentUsage,
              cost: segmentCost || undefined
            });
            pendingRoundUsage = null;
            if (traceStream && assistantMsg) {
              const event = trace.eventForMessage(assistantMsg);
              trace.write(traceStream, event.type, event.payload);
            }
          } catch { /* non-fatal */ }
        }
        assistantContent = '';
        assistantReasoning = '';
        // Emit the enriched frame (cost + usage attached) and skip the
        // generic emit below so the client never sees a cost-less copy.
        emit(name, Object.assign({}, data, {
          usage: segmentUsage,
          cost: segmentCost || undefined,
          modelId: model.id
        }));
        return;
      } else if (name === 'tool_call') {
        try {
          messages.appendMessage(projectDir, chatId, {
            role: 'tool', phase: 'call', toolCallId: data.id || '', name: data.name || '',
            args: data.args || {}, content: JSON.stringify(data.args || {})
          });
        } catch { /* non-fatal */ }
      } else if (name === 'tool_result') {
        try {
          messages.appendMessage(projectDir, chatId, {
            role: 'tool', phase: 'result', toolCallId: data.id || '', name: data.name || '',
            ok: !!data.ok, content: JSON.stringify(data.result || {})
          });
        } catch { /* non-fatal */ }
      } else if (name === 'done') {
        // Compute the enrichment once. `cost.known` is true when at
        // least one of the four pricing layers (model, app, builtin)
        // had a non-empty entry for this model id. We always emit
        // the enriched event so the UI can render `--` cleanly; the
        // `known: false` flag tells it not to show a dollar sign.
        let enriched = data;
        try {
          const app = settings.getApp();
          const providerCost = data && typeof data.providerCost === 'number' && isFinite(data.providerCost) && data.providerCost >= 0
            ? data.providerCost
            : null;
          const cost = providerCost == null
            ? usage.computeCost({ model, usage: data && data.usage, app })
            : { known: true, input: 0, output: 0, total: providerCost, currency: 'USD' };
          // Fold the still-open window (first delta → done) into the
          // accumulated tool-round windows. Falls back to the full
          // elapsed time when no message delta ever armed the start.
          const finalStreamingMs = streamingMs + (streamStartedAt ? Date.now() - streamStartedAt : 0);
          enriched = Object.assign({}, data, {
            cost: {
              known: cost.known,
              input: cost.input,
              output: cost.output,
              total: cost.total,
              currency: cost.currency
            },
            streamingMs: finalStreamingMs,
            modelId: model.id
          });
        } catch { /* keep data as-is on any pricing resolution error */ }
        lastEnrichment = enriched;
        pendingRoundUsage = null; // consumed by the final `done` cost
        // Persist the assistant message with the same enrichment so
        // a chat that is later reopened renders the same numbers
        // (decision §14 — the usage block rides the message).
        if (assistantContent || assistantReasoning) {
          try {
            assistantMsg = messages.appendMessage(projectDir, chatId, {
              role: 'assistant',
              content: assistantContent,
              reasoning: assistantReasoning,
              usage: data && data.usage,
              cost: enriched.cost,
              streamingMs: enriched.streamingMs,
              modelId: enriched.modelId
            });
          } catch { /* non-fatal */ }
        }
        if (traceStream && assistantMsg) {
          const event = trace.eventForMessage(assistantMsg);
          trace.write(traceStream, event.type, event.payload);
        }
        emit('done', enriched);
        return;
      }
      emit(name, data);
    }
  });
  } catch (streamErr) {
    // A throw out of the streaming layer must still clear the running
    // marker or the chat would look busy forever after a reload.
    runningChats.delete(runKey);
    if (traceStream) trace.close(traceStream);
    try { emit('error', { code: 'EINTERNAL', message: streamErr && streamErr.message ? streamErr.message : 'stream failed' }); } catch { /* socket closed */ }
    res.end();
    return;
  }

  if (!result.ok && !assistantContent && !assistantReasoning) {
    emit('error', Object.assign({ code: result.error.code || 'EUPSTREAM' }, result.error));
  }
  if (traceStream) trace.close(traceStream);
  runningChats.delete(runKey);
  res.end();
}

async function handleProjects(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // File editor (in-app CodeMirror popup). See handleFileEditor for the
  // contract; dispatched here so /api/file and /api/files win over the
  // generic /api/projects routes below.
  if (urlPath === '/api/file' || urlPath === '/api/files') {
    return handleFileEditor(req, res, parsed);
  }

  // File tagging (docs/decisions.md §15). Routes live under a
  // registered project id: /api/projects/:id/tags[/...]. Delegated to
  // handleTags before the folder-picker / registered-project routes so
  // the more specific path wins.
  if (/^\/api\/projects\/[^/]+\/tags(\/.*)?$/.test(urlPath)) {
    return handleTags(req, res, parsed);
  }

  // GET /api/projects?dir=<abs>  -> list subdirs
  if (urlPath === '/api/projects' && method === 'GET') {
    const dir = typeof q.dir === 'string' && q.dir ? q.dir : os.homedir();
    try {
      const result = projects.listDir(dir);
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, projectsErrorStatus(e), { error: e.message, code: e.code, path: e.path || dir });
    }
  }

  // GET /api/projects/registered
  if (urlPath === '/api/projects/registered' && method === 'GET') {
    return sendJSON(res, 200, { projects: projects.listProjects() });
  }

  // DELETE /api/projects/registered/:id
  const delMatch = urlPath.match(/^\/api\/projects\/registered\/([A-Za-z0-9_-]+)$/);
  if (delMatch && method === 'DELETE') {
    const ok = projects.removeProject(delMatch[1]);
    if (!ok) return sendJSON(res, 404, { error: 'Not found', id: delMatch[1] });
    return sendJSON(res, 200, { ok: true });
  }

  // PATCH /api/projects/registered/:id  body: { name }
  if (delMatch && method === 'PATCH') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const name = body && typeof body.name === 'string' ? body.name : '';
    if (!name.trim()) return sendJSON(res, 400, { error: 'name is required' });
    const updated = projects.renameProject(delMatch[1], name);
    if (!updated) return sendJSON(res, 404, { error: 'Not found', id: delMatch[1] });
    return sendJSON(res, 200, { project: updated });
  }

  // POST /api/projects  body: { action, ... }
  if (urlPath === '/api/projects' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const action = body && body.action;
    try {
      if (action === 'list') {
        const dir = typeof body.dir === 'string' && body.dir ? body.dir : os.homedir();
        return sendJSON(res, 200, projects.listDir(dir));
      }
      if (action === 'create') {
        if (typeof body.parent !== 'string' || typeof body.name !== 'string' || !body.name) {
          return sendJSON(res, 400, { error: 'parent and name are required' });
        }
        const target = path.join(body.parent, body.name);
        const out = projects.createDir(target);
        return sendJSON(res, 201, { ...out, parent: body.parent, name: body.name });
      }
      if (action === 'register') {
        if (typeof body.dir !== 'string' || !body.dir) {
          return sendJSON(res, 400, { error: 'dir is required' });
        }
        const row = projects.registerProject(body.dir);
        return sendJSON(res, 200, { project: row });
      }
      return sendJSON(res, 400, { error: 'Unknown action', action });
    } catch (e) {
      return sendJSON(res, projectsErrorStatus(e), { error: e.message, code: e.code, path: e.path });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'projects' });
}

// ---- File editor API ---------------------------------------------------
// Read + write text files inside a registered project folder, for the
// in-app CodeMirror editor popup. All paths are project-relative (or
// absolute under the project root). Both the project root and every
// read/write/list path go through files.resolveSafe, so the same
// home + MOUAIF_ALLOW_ANY_ROOT guard that protects the rest of the
// server applies here too.
//
// Endpoints:
//   GET  /api/files?projectDir=<abs>&dir=<abs>          -> list a folder
//   GET  /api/file?projectDir=<abs>&path=<abs|rel>      -> read a text file
//   PUT  /api/file   body { projectDir, path, content } -> write a text file
//
// Errors map to typed codes so the UI can render the right message
// (EBINARY -> "binary file, cannot edit", ETOOLARGE -> "file too big",
// EOUTSIDE_PROJECT -> 403, etc.).

function filesErrorStatus(err) {
  switch (err && err.code) {
    case 'EBADPATH':         return 400;
    case 'EBADINPUT':        return 400;
    case 'EOUTSIDE_PROJECT': return 403;
    case 'EOUTSIDE_HOME':    return 403;
    case 'ENOENT':           return 404;
    case 'ENOTDIR':          return 400;
    case 'ENOTFILE':         return 400;
    case 'EISDIR':           return 400;
    case 'EACCES':           return 403;
    case 'EBINARY':          return 415;
    case 'ETOOLARGE':        return 413;
    case 'EREAD':            return 500;
    default:                 return 400;
  }
}

async function handleFileEditor(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // GET /api/files?projectDir=<abs>&dir=<abs>  -> list a folder
  if (urlPath === '/api/files' && method === 'GET') {
    const projectDir = typeof q.projectDir === 'string' ? q.projectDir : '';
    const dir = typeof q.dir === 'string' ? q.dir : '';
    try {
      return sendJSON(res, 200, files.listDir(projectDir, dir));
    } catch (e) {
      return sendJSON(res, filesErrorStatus(e), { error: e.message, code: e.code, path: e.path });
    }
  }

  // GET /api/file?projectDir=<abs>&path=<abs|rel>  -> read a text file
  if (urlPath === '/api/file' && method === 'GET') {
    const projectDir = typeof q.projectDir === 'string' ? q.projectDir : '';
    const path = typeof q.path === 'string' ? q.path : '';
    try {
      const out = await files.readFile(projectDir, path);
      return sendJSON(res, 200, out);
    } catch (e) {
      return sendJSON(res, filesErrorStatus(e), { error: e.message, code: e.code, path: e.path, size: e.size, maxBytes: e.maxBytes });
    }
  }

  // PUT /api/file  body { projectDir, path, content }  -> write a text file
  if (urlPath === '/api/file' && method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    const path = body && typeof body.path === 'string' ? body.path : '';
    const content = body && typeof body.content === 'string' ? body.content : null;
    try {
      const out = await files.writeFile(projectDir, path, content);
      return sendJSON(res, 200, out);
    } catch (e) {
      return sendJSON(res, filesErrorStatus(e), { error: e.message, code: e.code, path: e.path, size: e.size, maxBytes: e.maxBytes });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'fileEditor' });
}

// ---- File tagging API ---------------------------------------------------
// Per-project file tags (docs/decisions.md §15). All routes hang off a
// registered project id so the UI never has to pass an absolute path:
//   GET    /api/projects/:id/tags               -> { tags: { ... } }
//   PUT    /api/projects/:id/tags               body { tags: {...} }
//   POST   /api/projects/:id/tags/scan          body { exts? }
//   DELETE /api/projects/:id/tags/files/<relPath>
// The project id resolves to its absolute dir via projects.getProject.
// Tag CRUD requires a registered project (404 otherwise). Path escapes
// return 403 EOUTSIDE_PROJECT.

function tagsErrorStatus(err) {
  switch (err && err.code) {
    case 'EBADINPUT':        return 400;
    case 'EOUTSIDE_PROJECT': return 403;
    case 'MOUAIF_PROJECT_PARSE_ERROR': return 422;
    default:                 return 500;
  }
}

async function handleTags(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;

  // Pull the project id out of the path and resolve to an absolute dir.
  const idMatch = urlPath.match(/^\/api\/projects\/([^/]+)\/tags/);
  if (!idMatch) return sendJSON(res, 404, { error: 'Not found', scope: 'tags' });
  const projectId = decodeURIComponent(idMatch[1]);
  const project = projects.getProject(projectId);
  if (!project) return sendJSON(res, 404, { error: 'Project not registered', id: projectId });
  const dir = project.path;

  const rest = urlPath.slice(idMatch[0].length); // '' | '/scan' | '/files/<rel>'

  // GET /api/projects/:id/tags
  if (rest === '' && method === 'GET') {
    try {
      return sendJSON(res, 200, { tags: tags.getTags(dir) });
    } catch (e) {
      return sendJSON(res, tagsErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PUT /api/projects/:id/tags  body: { tags: { ... } }
  if (rest === '' && method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const map = body && typeof body.tags === 'object' && body.tags ? body.tags : {};
    try {
      return sendJSON(res, 200, { tags: tags.setTags(dir, map) });
    } catch (e) {
      return sendJSON(res, tagsErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/projects/:id/tags/scan  body: { exts?: [...] }
  if (rest === '/scan' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const exts = body && Array.isArray(body.exts) ? body.exts : null;
    try {
      return sendJSON(res, 200, { files: tags.scanFiles(dir, exts) });
    } catch (e) {
      return sendJSON(res, tagsErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // DELETE /api/projects/:id/tags/files/<relPath>
  const fileMatch = rest.match(/^\/files\/(.+)$/);
  if (fileMatch && method === 'DELETE') {
    const relPath = decodeURIComponent(fileMatch[1]);
    try {
      const removed = tags.removeTag(dir, relPath);
      if (!removed) return sendJSON(res, 404, { error: 'Tag entry not found', path: relPath });
      return sendJSON(res, 200, { ok: true, removed: relPath });
    } catch (e) {
      return sendJSON(res, tagsErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'tags' });
}

// ---- AI API -------------------------------------------------------------
// Server-side proxy. The browser POSTs /api/ai/chat with { modelId,
// messages, projectDir? } and the server resolves the model record from
// the app + project settings, calls the upstream provider, and streams
// the response back as SSE.
//
// Implements docs/decisions.md section 10. Auth = apikey only in this
// commit; auth = oauth returns ENOAUTH (typed SSE error).

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

  // Never let committed project JSON redirect a global credential to an
  // attacker-controlled endpoint or replace auth/account/header policy.
  const safeModel = { ...m };
  delete safeModel.apiKey;
  delete safeModel.baseUrl;
  delete safeModel.auth;
  delete safeModel.oauthAccount;
  delete safeModel.headers;
  delete safeModel.staticHeaders;
  delete safeModel.authHeader;
  delete safeModel.token;
  delete safeModel.accessToken;

  const hydrated = Object.assign({}, connection || {}, safeModel, { provider: m.provider });
  if (!hydrated.auth) hydrated.auth = 'apikey';
  return hydrated;
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

async function handleAI(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;

  // GET /api/ai/models?projectDir=<abs>  -> list models visible to this project
  if (urlPath === '/api/ai/models' && method === 'GET') {
    const projectDir = typeof parsed.query.projectDir === 'string' ? parsed.query.projectDir : '';
    const resolved = settings.getResolved(projectDir || null);
    const models = (resolved.models || []).map(m => ({
      id: m.id, provider: m.provider, label: m.label, auth: m.auth || 'apikey'
    }));
    return sendJSON(res, 200, { models, providers: Object.keys(ai.ENDPOINTS) });
  }

  // GET /api/ai/models/live?provider=<id>  -> { models, fetchedAt, cached }
  // Live model list fetched from the upstream /models endpoint
  // (OpenAI-shaped), Gemini's /v1beta/models, Ollama's /api/tags, or
  // the curated Copilot catalog. Results are cached per-provider in
  // memory for an hour so opening many chats does not re-hit the
  // upstream. The chat UI calls this from the refresh button next to
  // the model <select>.
  if (urlPath === '/api/ai/models/live' && method === 'GET') {
    const provider = typeof parsed.query.provider === 'string' ? parsed.query.provider : '';
    if (!provider || !ai.ENDPOINTS[provider]) {
      return sendJSON(res, 400, { error: 'unknown provider', provider });
    }
    // Look up the app-level provider connection. Missing connection
    // is fine — OpenAI/OpenRouter/Gemini allow unauthenticated list
    // calls (rate-limited but useful), Ollama/Copilot don't need one.
    let cred = null;
    try { cred = credentialForProvider(provider); }
    catch { /* listModels will surface ENO_APIKEY if the provider requires a credential */ }
    // 1h cache keyed by `${provider}:${credHash}`.
    const cacheKey = provider + ':' + (cred ? hashShort(cred) : '-');
    const now = Date.now();

    // If _bust is provided, remove the entry from cache to force reload
    if (parsed.query._bust) {
      MODEL_LIST_CACHE.delete(cacheKey);
    }

    const cached = MODEL_LIST_CACHE.get(cacheKey);
    if (cached && (now - cached.fetchedAt) < MODEL_LIST_TTL_MS) {
      return sendJSON(res, 200, { models: cached.models, fetchedAt: cached.fetchedAt, cached: true });
    }
    // Bound the call so a slow upstream cannot hang the server. The
    // per-call AbortController is passed through to listModels so the
    // adapter can distinguish "user-configured" errors (ENO_APIKEY,
    // EUNREACHABLE, EUPSTREAM) from "we hit MODEL_LIST_TIMEOUT_MS and
    // cancelled" (EABORTED, surfaced as 504 Gateway Timeout).
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, MODEL_LIST_TIMEOUT_MS);
    // Pass signal through if the adapter accepts it.
    const args = cred ? [provider, cred, ac.signal] : [provider, null, ac.signal];
    ai.listModels(...args)
      .then((models) => {
        clearTimeout(timer);
        if (timedOut) {
          // Discard the late result: the client already saw 504.
          return;
        }
        MODEL_LIST_CACHE.set(cacheKey, { models, fetchedAt: Date.now() });
        return sendJSON(res, 200, { models, fetchedAt: Date.now(), cached: false });
      })
      .catch((err) => {
        clearTimeout(timer);
        if (timedOut) {
          return sendJSON(res, 504, { error: 'Timed out after ' + Math.round(MODEL_LIST_TIMEOUT_MS / 1000) + 's waiting for ' + provider + ' upstream', code: 'EABORTED', provider });
        }
        // Map typed error codes to HTTP statuses. 502 is reserved for
        // "upstream answered with a non-2xx" (EUPSTREAM) — anything
        // that isn't a recognized failure shape falls through to a
        // generic 502 so a regression in the adapter still surfaces
        // somewhere observable. Distinct failure modes get distinct
        // statuses so the chat UI can show a useful next step.
        const code = err && err.code;
        let status;
        if (code === 'ENO_LIST')       status = 400;
        else if (code === 'ENO_APIKEY') status = 400;
        else if (code === 'EUNREACHABLE') status = 503;
        else if (code === 'EUPSTREAM' && typeof err.status === 'number') status = err.status;
        else                            status = 502;
        const body = { error: String((err && err.message) || err), code: code || 'ELIVE', provider };
        if (code === 'EUPSTREAM' && typeof err.status === 'number') body.upstreamStatus = err.status;
        return sendJSON(res, status, body);
      });
    return;  // response is sent in the .then/.catch above.
  }

  // GET /api/ai/provider-credit?provider=<id> -> { supported, remaining? }
  // Provider-specific account balance lookup. Only OpenRouter exposes a
  // simple key-scoped credits endpoint; unsupported providers return
  // { supported: false } so the chat head can hide the pill.
  if (urlPath === '/api/ai/provider-credit' && method === 'GET') {
    const provider = typeof parsed.query.provider === 'string' ? parsed.query.provider : '';
    if (provider !== 'openrouter') return sendJSON(res, 200, { provider, supported: false });
    let cred;
    try { cred = credentialForProvider(provider); }
    catch (e) { return sendJSON(res, 400, { provider, supported: true, error: e.message, code: e.code || 'ENO_APIKEY' }); }
    if (!cred) return sendJSON(res, 400, { provider, supported: true, error: 'OpenRouter API key required', code: 'ENO_APIKEY' });
    let r;
    try {
      r = await fetch(ai.ENDPOINTS.openrouter.baseUrl + '/credits', {
        headers: { ...ai.ENDPOINTS.openrouter.authHeader(cred), ...ai.ENDPOINTS.openrouter.staticHeaders }
      });
    } catch (e) {
      return sendJSON(res, 503, { provider, supported: true, error: 'OpenRouter unreachable', code: 'EUNREACHABLE' });
    }
    if (!r.ok) return sendJSON(res, r.status, { provider, supported: true, error: 'OpenRouter returned ' + r.status, code: 'EUPSTREAM' });
    const body = await r.json().catch(() => ({}));
    const data = body && body.data ? body.data : body;
    const totalCredits = Number(data && (data.total_credits ?? data.totalCredits ?? data.credits));
    const totalUsage = Number(data && (data.total_usage ?? data.totalUsage ?? data.usage));
    const remaining = Number(data && (data.remaining_credits ?? data.remainingCredits ?? data.remaining));
    const value = isFinite(remaining) ? remaining : (isFinite(totalCredits) && isFinite(totalUsage) ? totalCredits - totalUsage : NaN);
    if (!isFinite(value)) return sendJSON(res, 502, { provider, supported: true, error: 'OpenRouter credit response missing totals', code: 'EBAD_CREDITS' });
    return sendJSON(res, 200, { provider, supported: true, label: 'Balance', remaining: value, totalCredits: isFinite(totalCredits) ? totalCredits : undefined, totalUsage: isFinite(totalUsage) ? totalUsage : undefined });
  }

  // GET /api/ai/models/providers -> { providers: [{ id }] }
  // The chat uses this when a project has no model records yet. Returning
  // every configured connection avoids the old "first provider wins"
  // fallback, which silently queried OpenAI when the user wanted OpenRouter.
  if (urlPath === '/api/ai/models/providers' && method === 'GET') {
    const app = settings.getApp();
    const providers = (Array.isArray(app.providers) ? app.providers : [])
      .filter((p) => p && typeof p.id === 'string' && ai.ENDPOINTS[p.id])
      .map((p) => ({ id: p.id }));
    return sendJSON(res, 200, { providers });
  }

  // GET /api/ai/models-all  -> { ids: [..] }
  // Union of every model id the user has configured across every
  // registered project + the app-level models list. Used by the
  // SettingsPricing view to surface "the ids you might want to
  // price" without forcing the user to remember project paths.
  if (urlPath === '/api/ai/models-all' && method === 'GET') {
    const ids = new Set();
    // App-level models (legacy / inline pricing tests)
    const app = settings.getApp();
    if (Array.isArray(app.models)) {
      for (const m of app.models) if (m && m.id) ids.add(m.id);
    }
    // Project-level models. Each registered project has its own
    // .mouaif.json; the registry is the source of truth for which
    // projects still exist on disk.
    const registered = projects.listProjects();
    for (const p of registered) {
      if (!p || !p.path) continue;
      try {
        const projSettings = settings.getProject(p.path);
        if (Array.isArray(projSettings.models)) {
          for (const m of projSettings.models) if (m && m.id) ids.add(m.id);
        }
      } catch { /* unreadable project file — skip */ }
    }
    return sendJSON(res, 200, { ids: Array.from(ids).sort() });
  }

  // POST /api/ai/test  body: { modelId, projectDir? }  -> { ok, error? }
  // Lightweight connectivity test: sends a single "hi" message and
  // checks whether the upstream returns a typed error or a 200 SSE
  // stream. Aborts after 10 s so the user never waits long.
  if (urlPath === '/api/ai/test' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }

    let model;
    try { model = resolveModel(body.modelId, body.projectDir); }
    catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code }); }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10000);
    try {
      const result = await ai.streamChat({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
        onEvent: () => {} // discard events, we only care about ok/error
      });
      clearTimeout(timer);
      if (result.ok) return sendJSON(res, 200, { ok: true });
      if (timedOut && result.error && result.error.code === 'EABORTED') {
        return sendJSON(res, 200, { ok: false, error: 'timed out after 10 s', code: 'ETIMEDOUT' });
      }
      return sendJSON(res, 200, { ok: false, error: (result.error && result.error.message) || 'upstream error' });
    } catch (e) {
      clearTimeout(timer);
      const code = e.code || 'ETEST';
      if (timedOut || code === 'EABORTED') {
        return sendJSON(res, 200, { ok: false, error: 'timed out after 10 s', code: 'ETIMEDOUT' });
      }
      return sendJSON(res, 200, { ok: false, error: e.message, code });
    }
  }

  // POST /api/ai/chat  body: { modelId, messages, projectDir? }  -> SSE stream
  if (urlPath === '/api/ai/chat' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }

    let model;
    try { model = resolveModel(body.modelId, body.projectDir); }
    catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code }); }

    // Open SSE.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    // Initial comment so the client sees headers immediately.
    res.write(': connected\n\n');

    const controller = new AbortController();
    req.on('close', () => { try { controller.abort(); } catch { /* ignore */ } });

    function emit(name, data) {
      try {
        res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n');
      } catch { /* socket already closed */ }
    }

    const result = await ai.streamChat({
      model,
      messages: body.messages || [],
      signal: controller.signal,
      onEvent: (name, data) => emit(name, data)
    });

    if (!result.ok) {
      emit('error', Object.assign({ code: result.error.code || 'EUPSTREAM' }, result.error));
    }
    res.end();
    return;
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'ai' });
}

// ---- Auth API -----------------------------------------------------------
// Implements docs/decisions.md section 11.
//
//   GET    /api/auth/accounts                       -> { accounts: { openai: [...], ... } }
//   GET    /api/auth/status?provider=<name>         -> { provider, accounts: [...], hasExchange: bool }
//   DELETE /api/auth/accounts/:provider/:account    -> { ok: true }
//
// The OAuth loopback callback (GET /oauth/callback) and the per-provider
// exchange registration live in src/auth.js + handleOAuthCallback below.

async function handleAuth(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  if (urlPath === '/api/auth/accounts' && method === 'GET') {
    return sendJSON(res, 200, { accounts: auth.listAccounts() });
  }

  if (urlPath === '/api/auth/status' && method === 'GET') {
    const provider = typeof q.provider === 'string' ? q.provider : '';
    if (!provider) return sendJSON(res, 400, { error: 'provider query param is required' });
    if (!auth.SUPPORTED_PROVIDERS.includes(provider)) {
      return sendJSON(res, 400, { error: 'Unknown provider', provider });
    }
    const accounts = auth.listAccounts();
    return sendJSON(res, 200, {
      provider,
      accounts: accounts[provider] || [],
      hasExchange: !!auth.getExchange(provider)
    });
  }

  const delMatch = urlPath.match(/^\/api\/auth\/accounts\/([a-z0-9-]+)\/(.+)$/);
  if (delMatch && method === 'DELETE') {
    const provider = delMatch[1];
    const account = decodeURIComponent(delMatch[2]);
    if (!auth.SUPPORTED_PROVIDERS.includes(provider)) {
      return sendJSON(res, 400, { error: 'Unknown provider', provider });
    }
    try {
      const r = auth.deleteToken(provider, account);
      return sendJSON(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      return sendJSON(res, 500, { error: e.message, code: e.code || 'EKEYRING' });
    }
  }

  // POST /api/auth/sign-in/anthropic  -> { authorizeUrl, state, expiresAt }
  // The UI calls this, opens authorizeUrl in the user's browser, and
  // polls GET /api/auth/status?provider=anthropic until hasExchange
  // (already registered) and accounts include the signed-in email.
  if (urlPath === '/api/auth/sign-in/anthropic' && method === 'POST') {
    if (!auth.getExchange('anthropic')) {
      return sendJSON(res, 501, { error: 'Anthropic OAuth is not registered in this build' });
    }
    let body = {};
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }

    const state = oauthAnthropic.newState();
    const verifier = oauthAnthropic.newVerifier();
    const callbackUrl = new URL(body.redirectUri || ('http://127.0.0.1:' + (req.socket.address() && req.socket.address().port) + '/oauth/callback'));
    // The callback handler is shared by providers and therefore requires the
    // provider name. OAuth providers return our redirect URI verbatim, so
    // bind the provider into it before recording the pending exchange.
    if (!callbackUrl.searchParams.has('provider')) callbackUrl.searchParams.set('provider', 'anthropic');
    const redirectUri = callbackUrl.toString();
    const scope = body.scope || oauthAnthropic.DEFAULT_SCOPE;

    auth.recordPending('anthropic', {
      state,
      codeVerifier: verifier,
      redirectUri,
      scopes: scope,
      accountHint: body.accountHint || ''
    });

    const authorizeUrl = oauthAnthropic.buildAuthorizeUrl({
      redirectUri,
      state,
      verifier,
      scope
    });

    return sendJSON(res, 200, {
      authorizeUrl,
      redirectUri,
      state,
      expiresAt: Date.now() + 5 * 60 * 1000,
      // Echoed for debugging; the production base is https://api.anthropic.com
      // unless MOUAIF_ANTHROPIC_API_BASE is set (test override).
      apiBase: oauthAnthropic.DEFAULT_API_BASE
    });
  }

  // POST /api/auth/sign-in/github-copilot  -> { authorizeUrl, state, expiresAt }
  // GitHub Copilot uses the standard GitHub OAuth web flow with PKCE
  // (decision §12: each provider picks its own auth shape). The user
  // signs in at github.com/login/oauth/authorize, gets redirected
  // back to /oauth/callback, the server exchanges the code for a
  // long-lived GitHub OAuth access token, and the per-request
  // Copilot API token is derived on demand by src/ai.js.
  if (urlPath === '/api/auth/sign-in/github-copilot' && method === 'POST') {
    if (!auth.getExchange('github-copilot')) {
      return sendJSON(res, 501, { error: 'GitHub Copilot OAuth is not registered in this build' });
    }
    let body = {};
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }

    const state = oauthCopilot.newState();
    const verifier = oauthCopilot.newVerifier();
    const callbackUrl = new URL(body.redirectUri || ('http://127.0.0.1:' + (req.socket.address() && req.socket.address().port) + '/oauth/callback'));
    if (!callbackUrl.searchParams.has('provider')) callbackUrl.searchParams.set('provider', 'github-copilot');
    const redirectUri = callbackUrl.toString();
    const scope = body.scope || oauthCopilot.DEFAULT_SCOPE;

    auth.recordPending('github-copilot', {
      state,
      codeVerifier: verifier,
      redirectUri,
      scopes: scope,
      accountHint: body.accountHint || ''
    });

    const authorizeUrl = oauthCopilot.buildAuthorizeUrl({
      redirectUri,
      state,
      verifier,
      scope
    });

    return sendJSON(res, 200, {
      authorizeUrl,
      redirectUri,
      state,
      expiresAt: Date.now() + 10 * 60 * 1000,
      // Echoed for debugging; the production base is the default.
      apiBase: oauthCopilot.COPILOT_API_BASE
    });
  }

  // POST /api/auth/sign-in/openrouter  -> { authorizeUrl, state, expiresAt }
  // OpenRouter's PKCE flow (docs/decisions.md §12). Unlike
  // Anthropic / GitHub Copilot, the loopback URL the user is
  // redirected back to is the same URL we pass in — OpenRouter
  // echoes it via the `callback_url` query param rather than
  // expecting a pre-registered redirect. The user signs in at
  // openrouter.ai/auth and OpenRouter redirects back to our
  // /oauth/callback with `?code=...&state=...`. The server
  // exchanges the code for a user-controlled OpenRouter API key
  // (src/oauth-openrouter.js) and stores it in the keyring under
  // the `openrouter` namespace. Subsequent chats use the same
  // Bearer header path as a manually pasted OpenRouter key.
  if (urlPath === '/api/auth/sign-in/openrouter' && method === 'POST') {
    if (!auth.getExchange('openrouter')) {
      return sendJSON(res, 501, { error: 'OpenRouter OAuth is not registered in this build' });
    }
    let body = {};
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }

    const rawState = oauthOpenRouter.newState();
    // Encode the provider in the state prefix so it survives the
    // OAuth redirect. OpenRouter does not forward ?provider= from
    // the callback_url, so we need the provider in a field the
    // IdP echoes back faithfully. See finishOAuth()'s state parsing.
    const state = 'openrouter:' + rawState;
    const verifier = oauthOpenRouter.newVerifier();
    const callbackUrl = new URL(body.redirectUri || ('http://127.0.0.1:' + (req.socket.address() && req.socket.address().port) + '/oauth/callback'));
    if (!callbackUrl.searchParams.has('provider')) callbackUrl.searchParams.set('provider', 'openrouter');
    const redirectUri = callbackUrl.toString();

    auth.recordPending('openrouter', {
      state,
      codeVerifier: verifier,
      redirectUri,
      scopes: 'openrouter',
      accountHint: body.accountHint || ''
    });

    const authorizeUrl = oauthOpenRouter.buildAuthorizeUrl({
      callbackUrl: redirectUri,
      state,
      verifier
    });

    return sendJSON(res, 200, {
      authorizeUrl,
      redirectUri,
      state,
      expiresAt: Date.now() + 10 * 60 * 1000,
      apiBase: oauthOpenRouter.KEYS_URL
    });
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'auth' });
}

// ---- OAuth loopback callback -------------------------------------------
// The provider redirects the user's browser here with
//   ?provider=<name>&state=<opaque>&code=<authcode>&error=<optional>
// We look up the pending record, hand the code to the provider's
// exchange function (registered via auth.registerExchange), persist the
// resulting token in the keyring, and reply with a tiny HTML page so the
// user can close the tab.

// Shared by the browser redirect (GET) and the no-browser fallback
// (POST). The shape of the response differs by route: GET renders a
// tiny HTML page, POST returns JSON. The exchange and keyring write
// are the same in both cases.
function htmlPage(title, body) {
  const safe = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + safe(title) + '</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:24px;max-width:480px}h1{font-size:1.1rem;margin:0 0 12px}p{color:#aaa;margin:0 0 12px}.ok{color:#7bd88f}.err{color:#ff8a8a}</style></head><body><h1>' + safe(title) + '</h1>' + body + '<p>You can close this tab.</p></body></html>';
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

async function handleOAuthCallback(req, res, parsed) {
  const q = parsed.query || {};
  const provider = typeof q.provider === 'string' ? q.provider : '';
  const state = typeof q.state === 'string' ? q.state : '';
  const code = typeof q.code === 'string' ? q.code : '';
  const errorParam = typeof q.error === 'string' ? q.error : '';

  const result = await finishOAuth({ provider, state, code, errorParam, format: 'html' });
  res.writeHead(result.status, { 'Content-Type': 'text/html; charset=utf-8' });
  if (result.status === 200) {
    res.end(htmlPage('Signed in', '<p class="ok">Signed in to <code>' + provider + '</code> as <code>' + result.account + '</code>.</p>'));
  } else if (result.code === 'EPROVIDER_ERROR') {
    res.end(htmlPage('Sign-in failed', '<p class="err">' + result.error + '</p>'));
  } else if (result.code === 'ENOEXCHANGE') {
    res.end(htmlPage('OAuth not configured', '<p class="err">Sign-in for <code>' + provider + '</code> is not configured in this build. A later commit will register the provider exchange.</p>'));
  } else {
    res.end(htmlPage('OAuth callback', '<p class="err">' + (result.error || 'unknown error') + '</p>'));
  }
}

async function handleOAuthCallbackPost(req, res, parsed) {
  let body = {};
  try { body = await readJsonBody(req); }
  catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const state = typeof body.state === 'string' ? body.state : '';
  const code = typeof body.code === 'string' ? body.code : '';
  const errorParam = typeof body.error === 'string' ? body.error : '';
  const result = await finishOAuth({ provider, state, code, errorParam, format: 'json' });
  if (result.status === 200) {
    return sendJSON(res, 200, { ok: true, provider, account: result.account });
  }
  return sendJSON(res, result.status, { ok: false, error: result.error, code: result.code });
}

// ---- Inspector API ------------------------------------------------------
// REST surface for the CDP bridge. The WebSocket proxy itself lives
// in src/inspector.js and is wired into the http.Server's 'upgrade'
// event in createServer() below.
//
// Endpoints:
//
//   GET  /api/inspector/config         -> { url, defaultUrl }
//   PUT  /api/inspector/config         body: { url }   -> { url }
//   GET  /api/inspector/version        -> Chrome /json/version payload
//   GET  /api/inspector/targets        -> Chrome /json/list payload
//
// The WS proxy is at /api/inspector/proxy and is the only way the
// mobile UI talks to the debugger — see docs/decisions.md section 6.

function inspectorErrorStatus(err) {
  switch (err && err.code) {
    case 'EBADURL':
    case 'EBADINPUT':
      return 400;
    case 'ECHROME_UNREACHABLE':
      return 502;
    case 'ETARGET_NOT_FOUND':
      return 404;
    case 'EUPSTREAM':
      return 502;
    case 'EPARSE':
      return 502;
    default:
      return 500;
  }
}

// ---- Tools API -----------------------------------------------------------
// The native shell tool's direct REST surface. Model-initiated calls run
// inside the AI client's tool loop; this endpoint powers the /shell
// composer command and lets a script run a project command directly.
// Routes:
//   GET  /api/tools/list?projectDir=<abs>
//     -> { tools: [{ name, kind, description, source }] }
//        Catalog of every tool the model can be advertised to use on
//        this project: native shell + file tools, plus MCP-discovered
//        tools whose server is currently running. The chat UI reads
//        this to render the per-chat tool toggles shown below the
//        system prompt on a brand-new chat.
//   POST /api/tools/shell  body: { projectDir, cmd, timeoutMs? }
//     -> { ok, stdout, stderr, exitCode, durationMs } | { ok:false, error, code }
// The tool is off unless the project's resolved settings enable it
// (settings.tools.shell.enabled). A disabled project returns
// ETOOL_DISABLED with HTTP 403.
async function handleTools(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // GET /api/tools/list?projectDir=<abs>
  // The catalog is read-only; it does not require a chat id. Native
  // tools are always present; MCP tools are filtered to servers
  // whose session is currently 'ready' (decisions §18: tools belong
  // to a running session). A server that is not running is not
  // listed — the user can start it from Settings → MCP, and a
  // subsequent call will pick up the newly discovered tools.
  if (urlPath === '/api/tools/list' && method === 'GET') {
    const projectDir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    // A chat opening (or the mobile UI re-loading a project) should
    // re-attach the MCP servers it needs. The Settings UI documents
    // this as "open a chat that references a stopped server" — without
    // it, the tool list comes back empty after a server restart even
    // though the servers are enabled, which reads as "not saved".
    try {
      await mcp.ensureEnabledServers(projectDir);
    } catch { /* best-effort; the AI client retries on demand */ }
    const tools = [];
    try {
      const shell = require('./tools/shell.js');
      tools.push({
        name: 'shell',
        kind: 'native',
        source: 'shell',
        description: (shell.SPEC && shell.SPEC.function && shell.SPEC.function.description) || 'Run a shell command in the project directory.'
      });
    } catch { /* shell module unavailable; omit */ }
    try {
      const subagent = require('./tools/subagent.js');
      tools.push({
        name: 'subagent',
        kind: 'native',
        source: 'subagent',
        description: (subagent.SPEC && subagent.SPEC.function && subagent.SPEC.function.description) || 'Delegate a focused task to a nested AI call.'
      });
    } catch { /* subagent module unavailable; omit */ }
    try {
      const ask = require('./tools/ask.js');
      tools.push({
        name: 'ask_user',
        kind: 'native',
        source: 'ask_user',
        description: (ask.SPEC && ask.SPEC.function && ask.SPEC.function.description) || 'Ask the user a structured question with 2-4 options.'
      });
    } catch { /* ask_user module unavailable; omit */ }
    try {
      const ft = require('./tools/files.js');
      for (const name of ft.FILE_TOOL_NAMES) {
        const spec = ft.SPECS && ft.SPECS[name];
        tools.push({
          name,
          kind: 'native',
          source: 'files',
          description: (spec && spec.function && spec.function.description) || ''
        });
      }
    } catch { /* files module unavailable; omit */ }
    try {
      const mcpMod = require('./mcp.js');
      const specs = mcpMod.listComposedToolSpecs(projectDir);
      for (const s of (specs || [])) {
        tools.push({
          name: s.name,
          kind: 'mcp',
          source: s.serverSlug || '',
          description: s.description || ''
        });
      }
    } catch { /* mcp module not loaded; no MCP tools */ }
    return sendJSON(res, 200, { tools });
  }

  if (urlPath === '/api/tools/shell' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    const cmd = body && typeof body.cmd === 'string' ? body.cmd : '';
    const timeoutMs = body && typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
    const chatId = body && typeof body.chatId === 'string' ? body.chatId : '';
    const callId = body && typeof body.callId === 'string' ? body.callId : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    if (!cmd) return sendJSON(res, 400, { error: 'cmd is required' });
    if (!chatId || !callId) return sendJSON(res, 400, { error: 'chatId and callId are required' });
    if (!chats.getChat(projectDir, chatId)) return sendJSON(res, 404, { error: 'Chat not found', chatId });

    // Gate on the per-project enable flag.
    let enabled = false;
    try {
      const resolved = settings.getResolved(projectDir || null);
      enabled = !!(resolved && resolved.tools && resolved.tools.shell && resolved.tools.shell.enabled);
    } catch { /* stays disabled */ }
    if (!enabled) {
      return sendJSON(res, 403, { ok: false, error: 'shell tool is disabled for this project', code: 'ETOOL_DISABLED' });
    }

    let authorization;
    try {
      authorization = await require('./tools/authorization.js').authorize({
        projectDir, chatId, callId, tool: 'shell', cmd, summary: cmd, timeoutMs, flow: 'retry'
      });
    } catch (e) {
      const status = e.code === 'ETOOL_DISABLED' || e.code === 'EDENIED' ? 403 : 400;
      return sendJSON(res, status, { ok: false, error: e.message, code: e.code || 'EAUTH' });
    }
    if (authorization.decision === 'prompt') {
      return sendJSON(res, 409, {
        ok: false,
        code: 'EAUTH_REQUIRED',
        chatId,
        callId,
        tool: 'shell',
        cmd,
        timeoutMs: authorization.timeoutMs,
        projectDir
      });
    }

    const out = await shellTool.runShell({ projectDir, cmd, timeoutMs: authorization.timeoutMs });
    const status = out.ok ? 200 : (out.code === 'EOUTSIDE_PROJECT' || out.code === 'ENOENT' ? 400 : 200);
    return sendJSON(res, status, out);
  }

  return sendJSON(res, 404, { error: 'Not found' });
}

// ---- Prompts API ---------------------------------------------------------
// Custom per-project prompts. Stored in the project file as project.prompts.
// Routes:
//   GET    /api/prompts?projectDir=<abs>          -> { prompts }
//   GET    /api/prompts/:id?projectDir=<abs>      -> { prompt }
//   POST   /api/prompts   body: { projectDir, title?, content, role? } -> { prompt }
//   PATCH  /api/prompts/:id  body: { projectDir, title?, content?, role? } -> { prompt }
//   DELETE /api/prompts/:id?projectDir=<abs>      -> { ok: true }

async function handlePrompts(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  function projectDirFrom(body) {
    const fromQuery = typeof q.projectDir === 'string' ? q.projectDir : '';
    const fromBody = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    return fromQuery || fromBody;
  }

  function promptError(e) {
    if (e && e.code === 'MOUAIF_PROJECT_PARSE_ERROR') return 422;
    if (e && e.code === 'EBADINPUT') return 400;
    return 500;
  }

  // GET /api/prompts?projectDir=<abs>
  if (urlPath === '/api/prompts' && method === 'GET') {
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      return sendJSON(res, 200, { prompts: prompts.listPrompts(dir) });
    } catch (e) {
      return sendJSON(res, promptError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/prompts/:id?projectDir=<abs>
  const getMatch = urlPath.match(/^\/api\/prompts\/([^/]+)$/);
  if (getMatch && method === 'GET') {
    const id = decodeURIComponent(getMatch[1]);
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      const p = prompts.getPrompt(dir, id);
      if (!p) return sendJSON(res, 404, { error: 'Prompt not found', id });
      return sendJSON(res, 200, { prompt: p });
    } catch (e) {
      return sendJSON(res, promptError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/prompts  body: { projectDir, title?, content, role? }
  if (urlPath === '/api/prompts' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = projectDirFrom(body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      const p = prompts.createPrompt(dir, body || {});
      return sendJSON(res, 201, { prompt: p });
    } catch (e) {
      return sendJSON(res, promptError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PATCH /api/prompts/:id  body: { projectDir, title?, content?, role? }
  if (getMatch && method === 'PATCH') {
    const id = decodeURIComponent(getMatch[1]);
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = projectDirFrom(body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      const p = prompts.updatePrompt(dir, id, body || {});
      if (!p) return sendJSON(res, 404, { error: 'Prompt not found', id });
      return sendJSON(res, 200, { prompt: p });
    } catch (e) {
      return sendJSON(res, promptError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // DELETE /api/prompts/:id?projectDir=<abs>
  if (getMatch && method === 'DELETE') {
    const id = decodeURIComponent(getMatch[1]);
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      let clearedChats = 0;
      const removed = prompts.deletePrompt(dir, id, {
        onRemoved: (deletedId) => { clearedChats = chats.clearPromptId(dir, deletedId); }
      });
      if (!removed) return sendJSON(res, 404, { error: 'Prompt not found', id });
      return sendJSON(res, 200, { ok: true, removed: id, clearedChats });
    } catch (e) {
      return sendJSON(res, promptError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'prompts' });
}

// ---- MCP API ------------------------------------------------------------
// Per-project MCP server registry + lifecycle + tool dispatch
// (docs/decisions.md §18). The server entries live in
// <projectDir>/.mcp.json under servers; legacy .mouaif.json
// mcp.servers is read as a fallback. Runtime state is
// in-memory. The AI client dispatches through the in-process mcp
// module, so these endpoints are for the Settings UI and for tests.
//
// All routes need a `projectDir` (query string for GET/DELETE, JSON
// body for POST/PATCH). The path is the canonical CRUD surface, the
// per-server action endpoints, and a generic /api/mcp/call that the
// AI client also uses for direct dispatch in tests.

function mcpErrorStatus(err) {
  switch (err && err.code) {
    case 'EBADINPUT':          return 400;
    case 'EMCP_NOTFOUND':      return 404;
    case 'EMCP_DISABLED':      return 409;
    case 'EOUTSIDE_PROJECT':   return 403;
    case 'EMCP_START':         return 502;
    case 'EMCP_RPC':           return 502;
    case 'EMCP_NOSESSION':     return 409;
    case 'EMCP_TIMEOUT':       return 504;
    case 'EMCP_TRANSPORT':     return 502;
    case 'EMODULE':            return 500;
    case 'MOUAIF_PROJECT_PARSE_ERROR': return 422;
    default:                   return 500;
  }
}

function readMcpProjectDir(q, body) {
  const fromQuery = typeof q.projectDir === 'string' ? q.projectDir : '';
  const fromBody = body && typeof body.projectDir === 'string' ? body.projectDir : '';
  return fromQuery || fromBody || '';
}

async function handleMcp(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // GET /api/mcp/servers?projectDir=...  -> { servers: [...] }
  if (urlPath === '/api/mcp/servers' && method === 'GET') {
    const dir = readMcpProjectDir(q);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      return sendJSON(res, 200, { servers: mcp.listServers(dir) });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/mcp/servers  body: { projectDir, name, command, args?, env?, cwd?, enabled? }
  if (urlPath === '/api/mcp/servers' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = readMcpProjectDir(q, body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      const server = mcp.addServer(dir, body);
      return sendJSON(res, 201, { server });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PATCH /api/mcp/servers/:id  body: { projectDir, ...patch }
  let m = urlPath.match(/^\/api\/mcp\/servers\/([^/]+)$/);
  if (m && method === 'PATCH') {
    const id = decodeURIComponent(m[1]);
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = readMcpProjectDir(q, body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      const server = mcp.updateServer(dir, id, body || {});
      if (!server) return sendJSON(res, 404, { error: 'Server not found', id });
      return sendJSON(res, 200, { server });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // DELETE /api/mcp/servers/:id?projectDir=...
  if (m && method === 'DELETE') {
    const id = decodeURIComponent(m[1]);
    const dir = readMcpProjectDir(q);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      const ok = mcp.removeServer(dir, id);
      if (!ok) return sendJSON(res, 404, { error: 'Server not found', id });
      return sendJSON(res, 200, { ok: true, removed: id });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/mcp/servers/:id/start  body: { projectDir }
  m = urlPath.match(/^\/api\/mcp\/servers\/([^/]+)\/start$/);
  if (m && method === 'POST') {
    const id = decodeURIComponent(m[1]);
    let body = {};
    try { body = await readJsonBody(req); } catch (e) { /* body may be empty */ }
    const dir = readMcpProjectDir(q, body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      const server = await mcp.startServer(dir, id);
      return sendJSON(res, 200, { server });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/mcp/servers/:id/stop  body: { projectDir }
  m = urlPath.match(/^\/api\/mcp\/servers\/([^/]+)\/stop$/);
  if (m && method === 'POST') {
    const id = decodeURIComponent(m[1]);
    let body = {};
    try { body = await readJsonBody(req); } catch (e) { /* body may be empty */ }
    const dir = readMcpProjectDir(q, body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      const ok = await mcp.stopServer(dir, id);
      return sendJSON(res, 200, { ok, removed: ok });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/mcp/servers/:id/tools?projectDir=...  -> forces a re-discovery
  m = urlPath.match(/^\/api\/mcp\/servers\/([^/]+)\/tools$/);
  if (m && method === 'GET') {
    const id = decodeURIComponent(m[1]);
    const dir = readMcpProjectDir(q);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      const tools = await mcp.listDiscoveredTools(dir, id);
      return sendJSON(res, 200, { tools });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/mcp/call  body: { projectDir, serverId, toolName, args }
  // Generic dispatch endpoint used by the AI client and by tests. The
  // AI client itself does not round-trip through HTTP; it calls
  // mcp.callTool() in-process. This endpoint is here for parity and
  // for a future UI action like "test this tool".
  if (urlPath === '/api/mcp/call' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = readMcpProjectDir(q, body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    if (!body || typeof body.serverId !== 'string' || !body.serverId) {
      return sendJSON(res, 400, { error: 'serverId is required' });
    }
    if (typeof body.toolName !== 'string' || !body.toolName) {
      return sendJSON(res, 400, { error: 'toolName is required' });
    }
    // Look up the server entry by id, then dispatch by its slug.
    try {
      const entry = mcp.getServer(dir, body.serverId);
      if (!entry) return sendJSON(res, 404, { error: 'Server not found', id: body.serverId });
      if (typeof body.chatId !== 'string' || typeof body.callId !== 'string') {
        return sendJSON(res, 400, { error: 'chatId and callId are required' });
      }
      if (!chats.getChat(dir, body.chatId)) return sendJSON(res, 404, { error: 'Chat not found', chatId: body.chatId });
      const tool = mcp.composedToolName(entry.slug, body.toolName);
      const authorization = await require('./tools/authorization.js').authorize({
        projectDir: dir,
        chatId: body.chatId,
        callId: body.callId,
        tool,
        summary: firstStringValue(body.args),
        flow: 'retry'
      });
      if (authorization.decision === 'prompt') {
        return sendJSON(res, 409, {
          ok: false,
          code: 'EAUTH_REQUIRED',
          projectDir: dir,
          chatId: body.chatId,
          callId: body.callId,
          tool,
          timeoutMs: authorization.timeoutMs
        });
      }
      const out = await mcp.callTool(dir, entry.slug, body.toolName, body.args || {});
      return sendJSON(res, 200, out);
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'mcp' });
}

// POST /api/restart  body: { reason?: string, delayMs?: number }
// Graceful restart: stop running MCP children, flush the JSON response,
// close the listening socket, then ask the launcher to relaunch. If no
// launcher hook exists, exit with code 0 so a supervisor can relaunch.
async function handleRestart(req, res, parsed, lifecycle = {}) {
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'POST only' });
  }
  let body = {};
  try { body = await readJsonBody(req); } catch (e) {
    if (e && e.status) return sendJSON(res, e.status, { error: e.message });
  }
  const reason = (body && typeof body.reason === 'string') ? body.reason : 'user-requested';
  const delayMs = (body && Number.isFinite(body.delayMs))
    ? Math.max(0, Math.min(body.delayMs, 5000))
    : 150;
  if (lifecycle.restarting) {
    return sendJSON(res, 409, { ok: false, restarting: true, error: 'Restart already in progress' });
  }
  lifecycle.restarting = true;
  sendJSON(res, 200, { ok: true, restarting: true, reason, delayMs, mode: lifecycle.restart ? 'relaunch' : 'exit' });
  setTimeout(async () => {
    try { process.stdout.write('[mouaif] restart requested: ' + reason + '\n'); } catch (_) {}
    try { await mcp.stopAll(); } catch (_) { /* best-effort */ }
    if (typeof lifecycle.restart === 'function') {
      try { await lifecycle.restart({ reason }); return; }
      catch (e) { try { process.stderr.write('[mouaif] restart failed: ' + (e && e.message || e) + '\n'); } catch (_) {} }
    }
    process.exit(0);
  }, delayMs).unref();
}

async function handleInspector(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // GET /api/inspector/config  -> { url, defaultUrl }
  if (urlPath === '/api/inspector/config' && method === 'GET') {
    return sendJSON(res, 200, { url: inspector.getDebuggerUrl(), defaultUrl: inspector.defaultDebuggerUrl() });
  }

  // PUT /api/inspector/config  body: { url }  -> { url }
  if (urlPath === '/api/inspector/config' && method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    if (!body || typeof body.url !== 'string') {
      return sendJSON(res, 400, { error: 'url is required' });
    }
    // Light validation: must be http(s)://... for the host lookup; we
    // do not check the port (could be anything).
    let parsedUrl;
    try { parsedUrl = new URL(body.url); }
    catch { return sendJSON(res, 400, { error: 'url is not a valid URL' }); }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return sendJSON(res, 400, { error: 'url must be http or https' });
    }
    inspector.setDebuggerUrl(body.url);
    return sendJSON(res, 200, { url: inspector.getDebuggerUrl() });
  }

  // GET /api/inspector/version  -> Chrome /json/version
  if (urlPath === '/api/inspector/version' && method === 'GET') {
    try {
      const info = await inspector.fetchInspectorInfo(inspector.getDebuggerUrl());
      return sendJSON(res, 200, info);
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EUPSTREAM' });
    }
  }

  // GET /api/inspector/targets  -> Chrome /json/list
  if (urlPath === '/api/inspector/targets' && method === 'GET') {
    try {
      const list = await inspector.fetchInspectorTargets(inspector.getDebuggerUrl());
      return sendJSON(res, 200, { targets: list });
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EUPSTREAM' });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'inspector' });
}

async function handleToolAuthorization(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};
  const authGate = require('./tools/authorization.js');

  // GET /api/tools/authorization?projectDir=<abs>
  if (urlPath === '/api/tools/authorization' && method === 'GET') {
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      return sendJSON(res, 200, authGate.getAuthorization(dir));
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // PUT /api/tools/authorization
  if (urlPath === '/api/tools/authorization' && method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const { projectDir, tools, mcp: mcpAuthorization } = body || {};
    if (!projectDir || typeof projectDir !== 'string') {
      return sendJSON(res, 400, { error: 'projectDir is required' });
    }
    try {
      const next = authGate.setAuthorization(projectDir, { tools, mcp: mcpAuthorization });
      return sendJSON(res, 200, next);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // POST /api/tools/authorization/decision
  if (urlPath === '/api/tools/authorization/decision' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const { projectDir, chatId, callId, decision, payload } = body || {};
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    if (!chatId) return sendJSON(res, 400, { error: 'chatId is required' });
    if (!callId) return sendJSON(res, 400, { error: 'callId is required' });
    if (!decision) return sendJSON(res, 400, { error: 'decision is required' });
    try {
      if (!chats.getChat(projectDir, chatId)) return sendJSON(res, 404, { error: 'Chat not found', chatId });
      // `payload` is an optional bag of structured data the chat UI
      // hands back alongside the decision. Today only the `ask_user`
      // tool reads it (the user's chosen option + free-form extra
      // text), but the channel is generic so a future native tool can
      // attach its own structured answer without a new endpoint.
      const out = authGate.recordDecision(projectDir, chatId, callId, decision, payload);
      return sendJSON(res, 200, out);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'tools-authorization' });
}

function createServer(port = DEFAULT_PORT, options = {}) {
  // Drop OAuth flows the user abandoned (closed the tab mid-sign-in). They
  // are never consumed and would otherwise accumulate PKCE verifiers in the
  // app store forever. Best-effort: a failure here must not stop the server.
  try {
    const pruned = auth.prunePending();
    if (pruned > 0) console.log(`[mouaif] pruned ${pruned} stale OAuth flow${pruned === 1 ? '' : 's'}`);
  } catch (e) {
    console.warn('[mouaif] could not prune stale OAuth flows:', e.message);
  }
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const lifecycle = (options && typeof options === 'object') ? (options.lifecycle || {}) : {};
  const server = http.createServer((req, res) => {
    // Bind port to the request handler
    handleRequest(req, res, port, sessionToken, lifecycle);
  });
  // WebSocket upgrade routing. Only /api/inspector/proxy is upgraded;
  // any other upgrade is rejected so the rest of the server stays
  // untouched. The noServer WebSocketServer gives us manual
  // handleUpgrade() so we can decide per-request.
  const wss = inspector.makeNoServerWss();
  server.on('upgrade', (req, socket, head) => {
    const u = req.url || '';
    if (u.startsWith('/api/inspector/proxy')) {
      const origin = requestOrigin(req);
      const expected = expectedOrigin(req);
      const cookies = parseCookies(req.headers.cookie);
      const actual = cookies[SESSION_COOKIE] || '';
      const validToken = actual.length === sessionToken.length
        && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(sessionToken));
      if (!origin || origin !== expected || !validToken) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.end();
        return;
      }
      // The inspector module does the heavy lifting. We pass `server`
      // so it can complete the upgrade on the browser side via
      // server.handleUpgrade().
      inspector.handleProxy(req, socket, head, { server, wss, debuggerUrl: inspector.getDebuggerUrl() })
        .catch((e) => {
          // Already-closed sockets are normal; the only way to surface
          // a true error here is to write a 500-style HTTP response on
          // the raw socket.
          try {
            socket.write('HTTP/1.1 500 Internal\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            socket.end();
          } catch { /* ignore */ }
        });
      return;
    }
    // Reject anything else.
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.end();
  });
  // Stash the wss so the inspector module can find it; not strictly
  // required today but lets a future commit add server-initiated
  // pushes (e.g. browser-driven "fetch the next page of history").
  void wss;
  return server;
}

module.exports = { createServer, broadcast, DEFAULT_PORT, settings, projects, ai, auth, oauthAnthropic, oauthCopilot, chats, resolveModel };

// ---- Static /web/ serving -----------------------------------------------

const WEB_MIME = {
  '.html':            'text/html; charset=utf-8',
  '.css':             'text/css; charset=utf-8',
  '.js':              'application/javascript; charset=utf-8',
  '.mjs':             'application/javascript; charset=utf-8',
  '.json':            'application/json; charset=utf-8',
  '.webmanifest':     'application/manifest+json; charset=utf-8',
  '.svg':             'image/svg+xml',
  '.png':             'image/png',
  '.webp':            'image/webp',
  '.ico':             'image/x-icon'
};

// Cache-Control for the PWA's static, fingerprinted assets (the
// hashed JS/CSS rollup emits). These URLs change on every build, so
// they can be cached forever by the browser; the cache name busts on
// each release because the hashed filename changes.
const LONG_LIVED = new Set(['.js', '.css', '.png', '.webp', '.svg', '.ico']);

// Headers the service worker script needs to be installed for the
// /web/ scope. SW scripts normally inherit their scope from their
// script URL's directory, but `Service-Worker-Allowed` lets the
// /web/sw.js script claim the entire /web/ prefix (which is what
// we want so navigation + static requests are both handled).
// `Cache-Control: no-cache` keeps the browser from serving a stale
// SW after a redeploy; the activate handler then evicts the old
// cache on the next load.
function applyPwaHeaders(res, absPath, relPath) {
  const ext = path.extname(absPath).toLowerCase();
  const isSw = relPath === 'sw.js';
  if (isSw) {
    res.setHeader('Service-Worker-Allowed', '/web/');
    res.setHeader('Cache-Control', 'no-cache');
    return;
  }
  if (LONG_LIVED.has(ext)) {
    // Cap to 1 year so we don't hand out "never expires" assets.
    // The Vite build hashes every entry, so a stale copy will be
    // garbage-collected next deploy anyway.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  if (relPath === 'manifest.webmanifest') {
    // Manifests are stable for a release (no content-hash in their
    // URL), so cache briefly — long enough for the install prompt
    // to be available offline, short enough to refresh across
    // deploys.
    res.setHeader('Cache-Control', 'public, max-age=300');
    return;
  }
}

function serveWebFile(res, absOrRel, opts) {
  const opt = opts || {};
  let abs;
  if (path.isAbsolute(absOrRel)) {
    abs = absOrRel;
  } else if (opt.preferDist) {
    // Look in src/web/dist/<relPath> first, fall back to src/web/<relPath>.
    const inDist = path.join(WEB_DIST, absOrRel);
    if (fs.existsSync(inDist)) abs = inDist;
    else abs = path.join(WEB_DIR, absOrRel);
  } else {
    abs = path.join(WEB_DIR, absOrRel);
  }
  // Allow serving from outside WEB_DIR only when the caller explicitly
  // opted in (used to be for the old virtual-list.js alias; no longer
  // needed now that Vite bundles it).
  if (!abs.startsWith(WEB_DIR) && !opt.allowOutside) {
    return sendJSON(res, 400, { error: 'Bad path' });
  }
  fs.readFile(abs, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'Not found', path: absOrRel });
    applyPwaHeaders(res, abs, absOrRel);
    res.writeHead(200, { 'Content-Type': WEB_MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveWebRequest(res, relPath) {
  if (!relPath) return serveWebFile(res, 'index.html', { preferDist: true });
  return serveWebFile(res, relPath, { preferDist: true });
}

function firstStringValue(value) {
  if (!value || typeof value !== 'object') return '';
  for (const item of Object.values(value)) if (typeof item === 'string') return item;
  return '';
}