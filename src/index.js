const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const settings = require('./settings.js');
const projects = require('./projects.js');
const ai = require('./ai.js');
const auth = require('./auth.js');
const oauthAnthropic = require('./oauth-anthropic.js');

// Register Anthropic's per-provider exchange function with the auth
// skeleton. Idempotent; safe to call from require-time side effects
// because auth.registerExchange overwrites cleanly.
oauthAnthropic.register();

const DEFAULT_PORT = 5732;
const WEB_DIR = path.join(__dirname, 'web');

// Store connected SSE clients
const sseClients = new Set();

// In-memory store for REST demo
const store = { message: 'Hello from mouaif!', timestamp: new Date().toISOString() };

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
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

function handleRequest(req, res, activePort = DEFAULT_PORT) {
  const parsed = url.parse(req.url, true);
  const urlPath = parsed.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE endpoint
  if (urlPath === '/events' && method === 'GET') {
    return handleSSE(req, res);
  }

  // Static /web/ (mobile UI bundle). Files live in src/web/. Alias
  // /web/virtual-list.js -> src/virtual-list.js so the same source powers
  // both the Node require() and the browser module.
  if (urlPath === '/web' || urlPath === '/web/') {
    return serveWebFile(res, 'index.html');
  }
  if (urlPath.startsWith('/web/')) {
    return serveWebRequest(res, urlPath.slice('/web/'.length));
  }

  // Browser auto-requests a favicon. Reply 204 (no body) so the console
  // doesn't pile up 404s; we don't ship a real favicon in this commit.
  if (urlPath === '/favicon.ico' && method === 'GET') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Settings API
  if (urlPath.startsWith('/api/settings')) {
    return handleSettings(req, res, parsed);
  }

  // Projects API (folder picker + registered projects)
  if (urlPath.startsWith('/api/projects')) {
    return handleProjects(req, res, parsed);
  }

  // AI proxy (server-side call to upstream providers; SSE stream back)
  if (urlPath.startsWith('/api/ai/')) {
    return handleAI(req, res, parsed);
  }

  // Auth API (account list, sign-out, status polling, sign-in)
  if (urlPath.startsWith('/api/auth/')) {
    return handleAuth(req, res, parsed);
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

  // REST: GET /
  if (urlPath === '/' && method === 'GET') {
    return sendJSON(res, 200, { status: 'ok', service: 'mouaif', port: activePort, endpoints: ['GET /', 'GET /data', 'POST /data', 'GET /events (SSE)', 'GET /api/settings', 'GET /api/settings/resolved?projectDir=...', 'GET /api/settings/project?projectDir=...', 'PUT /api/settings/app', 'PUT /api/settings/project', 'POST /api/settings/app/models', 'DELETE /api/settings/app/models/:id', 'POST /api/settings/app/reset', 'GET /api/projects?dir=...', 'POST /api/projects (list|create|register)', 'GET /api/projects/registered', 'DELETE /api/projects/registered/:id', 'GET /api/ai/models?projectDir=...', 'POST /api/ai/chat (SSE stream)', 'GET /api/auth/accounts', 'GET /api/auth/status?provider=...', 'DELETE /api/auth/accounts/:provider/:account', 'POST /api/auth/sign-in/anthropic', 'GET /oauth/callback', 'POST /oauth/callback (no-browser fallback)'] });
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
      defaults: settings.DEFAULTS,
      app: settings.getApp()
    });
  }

  // GET /api/settings/resolved?projectDir=<abs path>
  if (urlPath === '/api/settings/resolved' && method === 'GET') {
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      return sendJSON(res, 200, { resolved: settings.getResolved(dir) });
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
        project: settings.getProject(dir),
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
      const next = settings.setApp(patch);
      return sendJSON(res, 200, { app: next });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // PUT /api/settings/project  body: { projectDir, ...patch }
  if (urlPath === '/api/settings/project' && method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const { projectDir, ...patch } = body || {};
    if (!projectDir || typeof projectDir !== 'string') {
      return sendJSON(res, 400, { error: 'projectDir is required' });
    }
    try {
      const next = settings.setProject(projectDir, patch);
      return sendJSON(res, 200, { project: next, path: settings.getProjectPath(projectDir) });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

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
    const app = settings.getApp();
    const models = Array.isArray(app.models) ? app.models.slice() : [];
    const idx = models.findIndex(m => m && m.id === body.id);
    if (idx < 0 && !body.provider) {
      return sendJSON(res, 400, { error: 'provider is required when adding a new model' });
    }
    const merged = Object.assign({}, idx >= 0 ? models[idx] : {}, body);
    if (idx >= 0) models[idx] = merged; else models.push(merged);
    try {
      const next = settings.setApp({ models });
      return sendJSON(res, 200, { model: merged, models: next.models });
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
      return sendJSON(res, 200, { ok: true, removed, models });
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
      return sendJSON(res, 200, { app: result, reset: keys });
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

async function handleProjects(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

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

// ---- AI API -------------------------------------------------------------
// Server-side proxy. The browser POSTs /api/ai/chat with { modelId,
// messages, projectDir? } and the server resolves the model record from
// the app + project settings, calls the upstream provider, and streams
// the response back as SSE.
//
// Implements docs/decisions.md section 10. Auth = apikey only in this
// commit; auth = oauth returns ENOAUTH (typed SSE error).

function resolveModel(modelId, projectDir) {
  if (!modelId || typeof modelId !== 'string') {
    const e = new Error('modelId is required');
    e.code = 'EBADINPUT';
    throw e;
  }
  const resolved = settings.getResolved(projectDir || null);
  const list = Array.isArray(resolved.models) ? resolved.models : [];
  const m = list.find(x => x && x.id === modelId);
  if (!m) {
    const e = new Error('Model not found: ' + modelId);
    e.code = 'EMODEL_NOT_FOUND';
    throw e;
  }
  // Backfill auth default for models created before this commit.
  if (!m.auth) m.auth = 'apikey';
  return m;
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
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
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
    const redirectUri = body.redirectUri || ('http://127.0.0.1:' + (req.socket.address() && req.socket.address().port) + '/oauth/callback');
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
      state,
      expiresAt: Date.now() + 5 * 60 * 1000,
      // Echoed for debugging; the production base is https://api.anthropic.com
      // unless MOUAIF_ANTHROPIC_API_BASE is set (test override).
      apiBase: oauthAnthropic.DEFAULT_API_BASE
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

function createServer(port = DEFAULT_PORT) {
  const server = http.createServer((req, res) => {
    // Bind port to the request handler
    handleRequest(req, res, port);
  });
  return server;
}

module.exports = { createServer, broadcast, DEFAULT_PORT, settings, projects, ai, auth, oauthAnthropic };

// ---- Static /web/ serving -----------------------------------------------

const WEB_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon'
};

function serveWebFile(res, absOrRel, opts) {
  const abs = path.isAbsolute(absOrRel)
    ? absOrRel
    : path.join(WEB_DIR, absOrRel);
  if (!abs.startsWith(WEB_DIR) && !(opts && opts.allowOutside)) {
    return sendJSON(res, 400, { error: 'Bad path' });
  }
  fs.readFile(abs, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'Not found', path: absOrRel });
    res.writeHead(200, { 'Content-Type': WEB_MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveWebRequest(res, relPath) {
  if (!relPath) return serveWebFile(res, 'index.html');
  // /web/virtual-list.js -> src/virtual-list.js (single source of truth).
  if (relPath === 'virtual-list.js') {
    return serveWebFile(res, path.join(__dirname, 'virtual-list.js'), { allowOutside: true });
  }
  return serveWebFile(res, relPath);
}