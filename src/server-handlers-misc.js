'use strict';

// MCP + restart + inspector + tool-authorization REST handlers.
// Extracted from the original single-file http-server.js. Shared
// helpers live in src/server-shared.js.

const {
sendJSON,
qs,
readJsonBody,
readJsonOr400,
runningKey,
runningChats,
runningChatCancels,
firstStringValue,
chats,
liveChat,
mcp,
inspector,
inspectorProfiles,
safeDecode
} = require('./server-shared.js');
const { requestRestart } = require('./restart.js');


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
    case 'EOUTSIDE_PROJECT':   return 403;
    case 'EMCP_START':         return 502;
    case 'EMCP_RPC':           return 502;
    case 'EMCP_NOSESSION':     return 409;
    case 'EMCP_AUTH':          return 409;
    case 'EKEYRING':           return 503;
    case 'EMCP_TIMEOUT':       return 504;
    case 'EMCP_TRANSPORT':     return 502;
    case 'EMODULE':            return 500;
    case 'MOUAIF_PROJECT_PARSE_ERROR': return 422;
    default:                   return 500;
  }
}

function readMcpProjectDir(q, body) {
  const fromQuery = qs(q, 'projectDir');
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
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
    const id = safeDecode(m[1]);
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
    const id = safeDecode(m[1]);
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
    const id = safeDecode(m[1]);
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
    const id = safeDecode(m[1]);
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
    const id = safeDecode(m[1]);
    const dir = readMcpProjectDir(q);
    try {
      const tools = await mcp.listDiscoveredTools(dir || null, id);
      return sendJSON(res, 200, { tools });
    } catch (e) {
      return sendJSON(res, mcpErrorStatus(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/mcp/registry?search=...&cursor=...&limit=...
  // Statelessly proxies the official MCP Registry API. Registry responses
  // are never persisted or cached by mouaif.
  if (urlPath === '/api/mcp/registry' && method === 'GET') {
    const search = qs(q, 'search');
    const cursor = qs(q, 'cursor');
    const sortField = ['popularity', 'updatedAt', 'name'].includes(q.sort) ? q.sort : 'popularity';
    const sortDir = q.dir === 'asc' ? 'asc' : 'desc';
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

      // The Registry API does not expose sorting, so sort only this response
      // in memory. No registry result is written to app or project storage.
      const direction = sortDir === 'asc' ? 1 : -1;
      const text = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
      servers.sort((a, b) => {
        if (sortField === 'popularity') {
          return direction * ((a.popularity && a.popularity.score || 0) - (b.popularity && b.popularity.score || 0));
        }
        if (sortField === 'updatedAt') {
          const metaA = a._meta && a._meta['io.modelcontextprotocol.registry/official'];
          const metaB = b._meta && b._meta['io.modelcontextprotocol.registry/official'];
          const valueA = metaA && Date.parse(metaA.updatedAt) || 0;
          const valueB = metaB && Date.parse(metaB.updatedAt) || 0;
          return direction * (valueA - valueB);
        }
        const nameA = a.server && a.server.name || a.name || '';
        const nameB = b.server && b.server.name || b.name || '';
        return direction * text.compare(nameA, nameB);
      });

      return sendJSON(res, 200, {
        servers,
        metadata: registryBody.metadata || { count: servers.length, nextCursor: null }
      });
    } catch (e) {
      return sendJSON(res, 502, { error: 'Registry proxy error: ' + (e.message || e) });
    }
  }

  // POST /api/mcp/call  body: { projectDir, serverId, toolName, args }
  // Generic direct-dispatch endpoint used by the chat composer and tests.
  // The AI client itself does not round-trip through HTTP; it calls
  // mcp.callTool() in-process.
  if (urlPath === '/api/mcp/call' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
  const result = requestRestart({
lifecycle,
reason: body && body.reason,
delayMs: body && body.delayMs,
defaultDelayMs: 150
});
return sendJSON(res, result.ok ? 200 : 409, result);

}

async function handleInspector(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // GET /api/inspector/config  -> { url, defaultUrl, activeProfile }
  // `activeProfile` is `{ id, label }` or null. It is read from the store
  // (no scan), so the setup screen can name the active Chrome profile on
  // mount without a second round-trip.
  if (urlPath === '/api/inspector/config' && method === 'GET') {
    return sendJSON(res, 200, {
      url: inspector.getDebuggerUrl(),
      defaultUrl: inspector.defaultDebuggerUrl(),
      activeProfile: inspectorProfiles.activeProfile()
    });
  }

  // PUT /api/inspector/config  body: { url }  -> { url }
  if (urlPath === '/api/inspector/config' && method === 'PUT') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
    // A hand-typed URL is no longer attributable to a Chrome profile, so
    // drop the active badge rather than leave it claiming the profile
    // still owns this endpoint (see inspectorProfiles.clearActive).
    inspectorProfiles.clearActive();
    return sendJSON(res, 200, { url: inspector.getDebuggerUrl(), activeProfile: null });
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
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
  // POST /api/inspector/history  body: { targetId } -> { index, canGoBack, canGoForward, entries }
// Read-only session history for the attached tab (Page.getNavigationHistory
  // on the target's WebSocket). The nav row uses it to enable/disable the two
  // history arrows, so "there is nowhere to go" is visible before the tap
  // instead of being reported as a no-op afterwards.
  if (urlPath === '/api/inspector/history' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (!body || typeof body.targetId !== 'string' || !body.targetId.trim()) {
      return sendJSON(res, 400, { error: 'targetId is required' });
    }
    try {
      const result = await inspector.historyInspectorTarget(inspector.getDebuggerUrl(), body.targetId.trim());
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EUPSTREAM' });
    }
  }
  // POST /api/inspector/back  body: { targetId } -> { ok, wentBack }
  // Navigates a tab one entry back in its history (Page.navigateToHistoryEntry
  // on the target's WebSocket). `wentBack: false` means there was no previous
  // entry — the UI shows that as a no-op, not an error.
  if (urlPath === '/api/inspector/back' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (!body || typeof body.targetId !== 'string' || !body.targetId.trim()) {
      return sendJSON(res, 400, { error: 'targetId is required' });
    }
    try {
      const result = await inspector.goBackInspectorTarget(inspector.getDebuggerUrl(), body.targetId.trim());
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EUPSTREAM' });
    }
  }
  // POST /api/inspector/forward  body: { targetId } -> { ok, wentForward }
  // The other direction of the entry above, so a tab the user stepped back
  // from can be stepped forward again. Same no-op contract: `wentForward:
  // false` means there was no entry ahead.
  if (urlPath === '/api/inspector/forward' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (!body || typeof body.targetId !== 'string' || !body.targetId.trim()) {
      return sendJSON(res, 400, { error: 'targetId is required' });
    }
    try {
      const result = await inspector.goForwardInspectorTarget(inspector.getDebuggerUrl(), body.targetId.trim());
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EUPSTREAM' });
    }
  }

  // GET /api/inspector/profiles  -> discovered Chrome profiles + endpoints
  // Read-only discovery (see src/inspectorProfiles.js). Each profile
  // carries the debug endpoint Inspector would attach to, so the UI can
  // show the port and switch in one tap.
  if (urlPath === '/api/inspector/profiles' && method === 'GET') {
    try {
      return sendJSON(res, 200, inspectorProfiles.listProfiles());
    } catch (e) {
      return sendJSON(res, 500, { error: e.message, code: e.code || 'EPROFILES' });
    }
  }

  // POST /api/inspector/profiles/switch  body: { id } -> { url, profile }
  // Makes a profile the Inspector's attach point by writing its endpoint
  // into the existing global debugger URL. No Chrome is started or stopped.
  if (urlPath === '/api/inspector/profiles/switch' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return sendJSON(res, 400, { error: 'id is required' });
    }
    try {
      const result = inspectorProfiles.switchProfile(body.id.trim());
      return sendJSON(res, 200, {
        url: result.url,
        profile: { id: result.profile.id, key: result.profile.key, label: result.profile.label }
      });
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EPROFILES' });
    }
  }

  // POST /api/inspector/profiles/endpoint  body: { id, url } -> { url }
  // Remembers the endpoint for ONE profile without switching to it, so a
  // user can pre-configure ports before the other Chrome is running.
  if (urlPath === '/api/inspector/profiles/endpoint' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return sendJSON(res, 400, { error: 'id is required' });
    }
    if (typeof body.url !== 'string' || !body.url.trim()) {
      return sendJSON(res, 400, { error: 'url is required' });
    }
    try {
      const result = inspectorProfiles.setProfileEndpoint(body.id.trim(), body.url.trim());
      return sendJSON(res, 200, {
        url: result.url,
        profile: { id: result.profile.id, key: result.profile.key, label: result.profile.label }
      });
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EPROFILES' });
    }
  }

  // POST /api/inspector/profiles/dirs  body: { dir } -> { dir, profiles }
  // Registers an extra Chrome user-data-dir the automatic scan does not
  // know about (portable Chrome, a profile tree on another volume).
  if (urlPath === '/api/inspector/profiles/dirs' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (typeof body.dir !== 'string' || !body.dir.trim()) {
      return sendJSON(res, 400, { error: 'dir is required' });
    }
    try {
      return sendJSON(res, 200, inspectorProfiles.addDir(body.dir.trim()));
    } catch (e) {
      return sendJSON(res, inspectorErrorStatus(e), { error: e.message, code: e.code || 'EPROFILES' });
    }
  }

  // DELETE /api/inspector/profiles/dirs?dir=<abs path> -> { dir, removed }
  if (urlPath === '/api/inspector/profiles/dirs' && method === 'DELETE') {
    const dir = q.dir ? safeDecode(q.dir) : '';
    if (!dir) return sendJSON(res, 400, { error: 'dir is required' });
    return sendJSON(res, 200, inspectorProfiles.removeDir(dir));
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'inspector' });
}

function inspectorErrorStatus(err) {
switch (err && err.code) {
case 'EBADURL':
case 'EBADINPUT':
return 400;
// A profile id the scan does not know: the UI is holding a stale
// list (Chrome profile removed, or another mouaif window changed the
// active one), which is a 404 and not a server fault.
case 'EPROFILE_NOT_FOUND':
case 'ENOTPROFILEDIR':
return 404;
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

  // GET /api/tools/authorization?projectDir=<abs>[&chatId=<id>]
  // GET /api/tools/authorization?scope=app  -> the app-level MCP gate only.
  //
  // With `chatId` the response is scoped to ONE chat: the effective
  // modes are the chat's own overrides layered over the project / app
  // values, and `chat` carries those raw override maps so the chat's
  // Tools card and tool popup can show what this chat pinned. Without
  // `chatId` the response is the project view (what project settings
  // must render and edit) and carries no `chat` block.
  if (urlPath === '/api/tools/authorization' && method === 'GET') {
    if (q.scope === 'app') {
      try {
        return sendJSON(res, 200, authGate.getAppMcpAuthorization());
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    const chatId = qs(q, 'chatId');
    try {
      if (chatId && !chats.getChat(dir, chatId)) {
        return sendJSON(res, 404, { error: 'Chat not found', chatId });
      }
      return sendJSON(res, 200, authGate.getAuthorization(dir, chatId || undefined));
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // PUT /api/tools/authorization
  // Body shapes, in order of precedence:
  //   { chatId, scope: 'chat',   chat }            -> per-chat overrides
  //   { scope: 'app', mcp }                        -> app-level MCP gate
  //   { projectDir, tools, mcp }                   -> the project gate
  //
  // The chat scope is what the chat view's Tools card and tool popup
  // write: those controls are per-chat, and they must never touch
  // `.mouaif.json` / `.mcp.json`. Project settings keeps using the
  // project scope. See docs/features/tool-authorization.md.
  if (urlPath === '/api/tools/authorization' && method === 'PUT') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const { projectDir, scope, chatId, chat, tools, mcp: mcpAuthorization } = body || {};
    if (scope === 'chat') {
      if (!projectDir || typeof projectDir !== 'string') {
        return sendJSON(res, 400, { error: 'projectDir is required' });
      }
      if (!chatId || typeof chatId !== 'string') {
        return sendJSON(res, 400, { error: 'chatId is required for the chat scope' });
      }
      if (!chats.getChat(projectDir, chatId)) {
        return sendJSON(res, 404, { error: 'Chat not found', chatId });
      }
      try {
        // `null` keys inside `chat` clear that override (back to the
        // project value); `chat: null` clears every override at once.
        const next = authGate.setChatAuthorization(projectDir, chatId, chat);
        return sendJSON(res, 200, next);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
      }
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
    const projectDir = qs(q, 'projectDir');
    const chatId = qs(q, 'chatId');
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
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
      const runKey = runningKey(projectDir, chatId);
      const out = authGate.recordDecision(projectDir, chatId, callId, decision, payload);
      // Tell follower tabs/pages to drop any replayed prompt immediately.
      // Without this, a page that returned to a paused stream could keep a
      // stale approval card until the next transcript sync.
      liveChat.pruneLive(runKey, callId);
      return sendJSON(res, 200, out);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'tools-authorization' });
}

module.exports = { handleMcp, handleRestart, handleInspector, handleToolAuthorization };
