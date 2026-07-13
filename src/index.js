const http = require('http');
const url = require('url');
const settings = require('./settings.js');

const DEFAULT_PORT = 5732;

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
  const path = parsed.pathname;
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
  if (path === '/events' && method === 'GET') {
    return handleSSE(req, res);
  }

  // Settings API
  if (path.startsWith('/api/settings')) {
    return handleSettings(req, res, parsed);
  }

  // REST: GET /
  if (path === '/' && method === 'GET') {
    return sendJSON(res, 200, { status: 'ok', service: 'mouaif', port: activePort, endpoints: ['GET /', 'GET /data', 'POST /data', 'GET /events (SSE)', 'GET /api/settings', 'GET /api/settings/resolved?projectDir=...', 'PUT /api/settings/app', 'PUT /api/settings/project'] });
  }

  // REST: GET /data
  if (path === '/data' && method === 'GET') {
    return sendJSON(res, 200, store);
  }

  // REST: POST /data
  if (path === '/data' && method === 'POST') {
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
  const path = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // GET /api/settings -> { app, defaults, home }
  if (path === '/api/settings' && method === 'GET') {
    return sendJSON(res, 200, {
      home: settings.MOUAIF_HOME,
      defaults: settings.DEFAULTS,
      app: settings.getApp()
    });
  }

  // GET /api/settings/resolved?projectDir=<abs path>
  if (path === '/api/settings/resolved' && method === 'GET') {
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
  if (path === '/api/settings/app' && method === 'PUT') {
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
  if (path === '/api/settings/project' && method === 'PUT') {
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

function createServer(port = DEFAULT_PORT) {
  const server = http.createServer((req, res) => {
    // Bind port to the request handler
    handleRequest(req, res, port);
  });
  return server;
}

module.exports = { createServer, broadcast, DEFAULT_PORT, settings };