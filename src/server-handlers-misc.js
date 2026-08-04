'use strict';

// MCP + restart + inspector + tool-authorization REST handlers.
// Extracted from the original single-file http-server.js. Shared
// helpers live in src/server-shared.js.

const {
  sendJSON,
  readJsonBody,
  runningKey,
  runningChats,
  runningChatCancels,
  firstStringValue,
  chats,
  mcp,
  inspector
} = require('./server-shared.js');

// ---- MCP API ------------------------------------------------------------
// MCP server registry + lifecycle + tool dispatch (docs/decisions.md §18).
// Server entries live in one of two scopes:
//   - project: <projectDir>/.mcp.json under servers (legacy .mouaif.json
//     mcp.servers is read as a fallback);
//   - app: the app SQLite store under mcp.servers.
// A project sees the union; project entries win on a slug collision.
// Runtime state is in-memory. The AI client dispatches through the
// in-process mcp module, so these endpoints are for the Settings UI and
// for tests.
//
// Routes that touch the *merged* view (list, patch, delete, lifecycle)
// take an optional `projectDir` — without one only app-scoped servers
// are visible. POST /api/mcp/servers takes an explicit `scope`
// ('project' | 'app'); project scope requires `projectDir`.

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
  // projectDir is optional: without it only app-scoped servers are
  // returned (the Settings "App" tab); with it the response is the
  // merged app + project view.
  if (urlPath === '/api/mcp/servers' && method === 'GET') {
    const dir = readMcpProjectDir(q);
    try {
      return sendJSON(res, 200, { servers: mcp.listServers(dir || null) });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/mcp/servers  body: { projectDir?, scope?, name, command, args?, env?, cwd?, enabled? }
  if (urlPath === '/api/mcp/servers' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = readMcpProjectDir(q, body);
    const scope = body && body.scope === mcp.APP_SCOPE ? mcp.APP_SCOPE : mcp.PROJECT_SCOPE;
    if (scope === mcp.PROJECT_SCOPE && !dir) return sendJSON(res, 400, { error: 'projectDir is required for a project-scoped server' });
    try {
      const server = mcp.addServer(dir || null, Object.assign({}, body, { scope }));
      return sendJSON(res, 201, { server });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PATCH /api/mcp/servers/:id  body: { projectDir?, ...patch }
  let m = urlPath.match(/^\/api\/mcp\/servers\/([^/]+)$/);
  if (m && method === 'PATCH') {
    const id = decodeURIComponent(m[1]);
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const dir = readMcpProjectDir(q, body);
    try {
      const server = mcp.updateServer(dir || null, id, body || {});
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
    try {
      const ok = mcp.removeServer(dir || null, id);
      if (!ok) return sendJSON(res, 404, { error: 'Server not found', id });
      return sendJSON(res, 200, { ok: true, removed: id });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/mcp/servers/:id/start  body: { projectDir? }
  m = urlPath.match(/^\/api\/mcp\/servers\/([^/]+)\/start$/);
  if (m && method === 'POST') {
    const id = decodeURIComponent(m[1]);
    let body = {};
    try { body = await readJsonBody(req); } catch (e) { /* body may be empty */ }
    const dir = readMcpProjectDir(q, body);
    try {
      const server = await mcp.startServer(dir || null, id);
      return sendJSON(res, 200, { server });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/mcp/servers/:id/stop  body: { projectDir? }
  m = urlPath.match(/^\/api\/mcp\/servers\/([^/]+)\/stop$/);
  if (m && method === 'POST') {
    const id = decodeURIComponent(m[1]);
    let body = {};
    try { body = await readJsonBody(req); } catch (e) { /* body may be empty */ }
    const dir = readMcpProjectDir(q, body);
    try {
      const ok = await mcp.stopServer(dir || null, id);
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
    try {
      const tools = await mcp.listDiscoveredTools(dir || null, id);
      return sendJSON(res, 200, { tools });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/mcp/registry?search=...&cursor=...&limit=...
  // Proxies the official MCP Registry API (registry.modelcontextprotocol.io).
  // Returns paginated results with a computed popularity score.
  // Caches responses in-memory for 30 seconds to avoid hammering the registry.
  if (urlPath === '/api/mcp/registry' && method === 'GET') {
    const search = typeof q.search === 'string' ? q.search : '';
    const cursor = typeof q.cursor === 'string' ? q.cursor : '';
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 30, 1), 100);
    try {
      const registryUrl = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
      if (search) registryUrl.searchParams.set('search', search);
      if (cursor) registryUrl.searchParams.set('cursor', cursor);
      registryUrl.searchParams.set('limit', String(limit));
      registryUrl.searchParams.set('version', 'latest');
      const registryRes = await fetch(registryUrl, {
        headers: { 'Accept': 'application/json' }
      });
      if (!registryRes.ok) {
        return sendJSON(res, registryRes.status, { error: 'Registry API error: HTTP ' + registryRes.status });
      }
      const registryBody = await registryRes.json();
      // Enrich with a computed popularity score (0-100) based on
      // recency of updates and the number of packages.
      const now = Date.now();
      const enrich = (entry) => {
        const meta = entry && entry._meta && entry._meta['io.modelcontextprotocol.registry/official'];
        const server = entry && entry.server || {};
        const updatedAt = meta && meta.updatedAt ? new Date(meta.updatedAt).getTime() : null;
        const publishedAt = meta && meta.publishedAt ? new Date(meta.publishedAt).getTime() : null;
        const packages = Array.isArray(server.packages) ? server.packages : [];
        // Score: 0-50 from update recency (within 30 days = max)
        let recencyScore = 0;
        if (updatedAt) {
          const daysSinceUpdate = (now - updatedAt) / 86400000;
          recencyScore = Math.max(0, Math.round(50 * (1 - Math.min(daysSinceUpdate / 90, 1))));
        } else if (publishedAt) {
          const daysSincePub = (now - publishedAt) / 86400000;
          recencyScore = Math.max(0, Math.round(30 * (1 - Math.min(daysSincePub / 365, 1))));
        }
        // Score: 0-30 from number of packages (3+ packages = max)
        const pkgScore = Math.min(30, packages.length * 10);
        // Score: 0-20 from version count proxy (multiple versions = active)
        let versionScore = 10; // baseline
        if (meta && meta.isLatest !== undefined) versionScore += 10;
        const score = Math.min(100, recencyScore + pkgScore + versionScore);
        return Object.assign({}, entry, {
          popularity: { score, recencyScore, pkgScore, versionScore }
        });
      };
      const servers = Array.isArray(registryBody.servers)
        ? registryBody.servers.map(enrich)
        : [];
      return sendJSON(res, 200, {
        servers,
        metadata: registryBody.metadata || { count: servers.length, nextCursor: null }
      });
    } catch (e) {
      return sendJSON(res, 502, { error: 'Registry proxy error: ' + (e.message || e) });
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
      try {
        await lifecycle.restart({ reason });
        lifecycle.restarting = false;
        return;
      }
      catch (e) {
        try { process.stderr.write('[mouaif] restart failed: ' + (e && e.message || e) + '\n'); } catch (_) {}
        lifecycle.restarting = false;
      }
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

  // POST /api/inspector/open  body: { url }  -> { target }
  // Opens the page URL in a NEW tab of the debug Chrome (Chrome
  // /json/new) and returns the fresh target record. The UI then
  // attaches straight to it — the "inspect this URL" one-step flow.
  if (urlPath === '/api/inspector/open' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    if (!body || typeof body.url !== 'string' || !body.url.trim()) {
      return sendJSON(res, 400, { error: 'url is required' });
    }
    let parsedUrl;
    try { parsedUrl = new URL(body.url.trim()); }
    catch { return sendJSON(res, 400, { error: 'url is not a valid URL' }); }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return sendJSON(res, 400, { error: 'url must be http or https' });
    }
    try {
      const target = await inspector.openInspectorTarget(inspector.getDebuggerUrl(), parsedUrl.href);
      return sendJSON(res, 200, { target });
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EUPSTREAM' });
    }
  }

  // POST /api/inspector/close  body: { targetId }  -> { ok: true }
  // Closes a tab of the debug Chrome (Target.closeTarget on the
  // browser-level WebSocket).
  if (urlPath === '/api/inspector/close' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    if (!body || typeof body.targetId !== 'string' || !body.targetId.trim()) {
      return sendJSON(res, 400, { error: 'targetId is required' });
    }
    try {
      const result = await inspector.closeInspectorTarget(inspector.getDebuggerUrl(), body.targetId.trim());
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EUPSTREAM' });
    }
  }

  // POST /api/inspector/reload  body: { targetId }  -> { ok: true }
  // Reloads a tab of the debug Chrome (Page.reload on the target's
  // WebSocket).
  if (urlPath === '/api/inspector/reload' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    if (!body || typeof body.targetId !== 'string' || !body.targetId.trim()) {
      return sendJSON(res, 400, { error: 'targetId is required' });
    }
    try {
      const result = await inspector.reloadInspectorTarget(inspector.getDebuggerUrl(), body.targetId.trim());
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EUPSTREAM' });
    }
  }

  // POST /api/inspector/navigate  body: { targetId, url } -> { frameId, loaderId }
  // Navigates a tab of the debug Chrome to a new URL (Page.navigate on
  // the target's WebSocket).
  if (urlPath === '/api/inspector/navigate' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    if (!body || typeof body.targetId !== 'string' || !body.targetId.trim()) {
      return sendJSON(res, 400, { error: 'targetId is required' });
    }
    if (typeof body.url !== 'string' || !body.url.trim()) {
      return sendJSON(res, 400, { error: 'url is required' });
    }
    let parsedUrl;
    try { parsedUrl = new URL(body.url.trim()); }
    catch { return sendJSON(res, 400, { error: 'url is not a valid URL' }); }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return sendJSON(res, 400, { error: 'url must be http or https' });
    }
    try {
      const result = await inspector.navigateInspectorTarget(inspector.getDebuggerUrl(), body.targetId.trim(), parsedUrl.href);
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EUPSTREAM' });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'inspector' });
}

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

async function handleToolAuthorization(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};
  const authGate = require('./tools/authorization.js');

  // GET /api/tools/authorization?projectDir=<abs>
  // GET /api/tools/authorization?scope=app  -> the app-level MCP gate only.
  if (urlPath === '/api/tools/authorization' && method === 'GET') {
    if (q.scope === 'app') {
      try {
        return sendJSON(res, 200, authGate.getAppMcpAuthorization());
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }
    const dir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      return sendJSON(res, 200, authGate.getAuthorization(dir));
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // PUT /api/tools/authorization
  // With { scope: 'app', mcp } the app-level shared MCP gate is written
  // (no projectDir). Otherwise projectDir is required and the project
  // tools + MCP authorization are written as before.
  if (urlPath === '/api/tools/authorization' && method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const { projectDir, scope, tools, mcp: mcpAuthorization } = body || {};
    if (scope === 'app') {
      try {
        const next = authGate.setAppMcpAuthorization({ mcp: mcpAuthorization });
        return sendJSON(res, 200, next);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }
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

  // GET /api/tools/authorization/pending?projectDir=<abs>&chatId=<id>
  if (urlPath === '/api/tools/authorization/pending' && method === 'GET') {
    const projectDir = typeof q.projectDir === 'string' ? q.projectDir : '';
    const chatId = typeof q.chatId === 'string' ? q.chatId : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    if (!chatId) return sendJSON(res, 400, { error: 'chatId query param is required' });
    try {
      if (!chats.getChat(projectDir, chatId)) return sendJSON(res, 404, { error: 'Chat not found', chatId });
      return sendJSON(res, 200, { pending: authGate.listPending(projectDir, chatId) });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // POST /api/tools/authorization/cancel
  if (urlPath === '/api/tools/authorization/cancel' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const { projectDir, chatId } = body || {};
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    if (!chatId) return sendJSON(res, 400, { error: 'chatId is required' });
    try {
      if (!chats.getChat(projectDir, chatId)) return sendJSON(res, 404, { error: 'Chat not found', chatId });
      const key = runningKey(projectDir, chatId);
      const controller = runningChatCancels.get(key);
      if (controller) {
        try { controller.abort(new Error('user cancelled chat')); } catch { /* already settled */ }
      }
      return sendJSON(res, 200, { ok: true, cancelled: authGate.cancelSession(projectDir, chatId), running: runningChats.has(key) });
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

module.exports = { handleMcp, handleRestart, handleInspector, handleToolAuthorization };
