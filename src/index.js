const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const settings = require('./settings.js');
const projects = require('./projects.js');
const ai = require('./ai.js');

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

  // REST: GET /
  if (urlPath === '/' && method === 'GET') {
    return sendJSON(res, 200, { status: 'ok', service: 'mouaif', port: activePort, endpoints: ['GET /', 'GET /data', 'POST /data', 'GET /events (SSE)', 'GET /api/settings', 'GET /api/settings/resolved?projectDir=...', 'PUT /api/settings/app', 'PUT /api/settings/project', 'GET /api/projects?dir=...', 'POST /api/projects (list|create|register)', 'GET /api/projects/registered', 'DELETE /api/projects/registered/:id', 'GET /api/ai/models?projectDir=...', 'POST /api/ai/chat (SSE stream)'] });
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

function createServer(port = DEFAULT_PORT) {
  const server = http.createServer((req, res) => {
    // Bind port to the request handler
    handleRequest(req, res, port);
  });
  return server;
}

module.exports = { createServer, broadcast, DEFAULT_PORT, settings };

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