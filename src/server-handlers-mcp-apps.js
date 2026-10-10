'use strict';
const crypto = require('node:crypto');
const settings = require('./settings.js');
const chats = require('./chats.js');
const messages = require('./messages.js');
const mcp = require('./mcp.js');
const apps = require('./mcp-apps.js');
const authz = require('./tools/authorization.js');
const { sendJSON, readJsonOr400, expectedOrigin } = require('./server-shared.js');
const { buildPolicy, createSandboxService } = require('./mcp-apps-sandbox.js');
const { err } = require('./util.js');

function createMcpAppsHost(options = {}) {
  const sandbox = createSandboxService(options);
  const mounts = new Map();
  function dispose(id) {
    const mount = mounts.get(id);
    if (!mount) return;
    mounts.delete(id);
    sandbox.revoke(mount.ticket.token);
    for (const request of mount.requests.values()) {
      request.controller.abort();
      try { authz.recordDecision(mount.projectDir, mount.chatId, request.callId, 'deny'); } catch { /* not pending */ }
    }
  }
  const timer = setInterval(() => {
    for (const [id, mount] of mounts) if (mount.expires < Date.now()) dispose(id);
  }, 60000);
  timer.unref();

  function validate(mount) {
    if (!mount || mount.expires < Date.now()) throw err('EMCP_APP_GONE', 'MCP App was closed or expired');
    if (settings.getProject(mount.projectDir).mcpApps?.enabled !== true) throw err('ETOOL_DISABLED', 'MCP Apps are disabled');
    const session = mcp._sessions.get(mount.projectDir + '::' + mount.serverId);
    if (session !== mount.session || session?.status !== 'ready') throw err('EMCP_APP_GONE', 'MCP App server disconnected');
    if (session.appResourceEpoch !== mount.epoch) throw err('EMCP_APP_STALE', 'MCP App resource changed; reload');
    if (!chats.getChat(mount.projectDir, mount.chatId)) throw err('EMCP_APP_GONE', 'Chat was removed');
    return session;
  }

  async function handle(req, res, parsed, publicOrigin) {
    try {
      const body = await readJsonOr400(req, res);
      if (!body) return;
      if (parsed.pathname === '/api/mcp/apps/mount' && req.method === 'POST') {
        const { projectDir, chatId, callId } = body;
        if (typeof projectDir !== 'string' || typeof chatId !== 'string' || typeof callId !== 'string') throw err('EBADINPUT', 'projectDir, chatId and callId are required');
        if (settings.getProject(projectDir).mcpApps?.enabled !== true) return sendJSON(res, 200, { enabled: false });
        if (!chats.getChat(projectDir, chatId)) throw err('EMCP_NOTFOUND', 'Chat not found');
        // The frame identity and original tool input/result come from persisted
        // transcript rows, never server IDs or HTML supplied by the browser.
        const rows = messages.listMessages(projectDir, chatId);
        const call = rows.find(r => r.role === 'tool' && r.phase === 'call' && r.toolCallId === callId);
        const result = rows.find(r => r.role === 'tool' && r.phase === 'result' && r.toolCallId === callId);
        if (!call || !result) throw err('EMCP_NOTFOUND', 'Completed tool call not found');
        const parsedTool = mcp.parseServerSlugAndToolName(call.name);
        if (!parsedTool) throw err('EBADINPUT', 'Not an MCP tool call');
        const server = mcp.listServers(projectDir).find(s => s.slug === parsedTool.serverSlug);
        if (!server) throw err('EMCP_NOTFOUND', 'MCP server not found');
        if (authz.effectiveConfig(projectDir, call.name, chatId).mode === 'off') throw err('ETOOL_DISABLED', 'MCP tool is disabled');
        // Do not silently start stopped servers merely to render old results.
        const session = mcp._sessions.get(projectDir + '::' + server.id);
        const tool = session?.tools.find(t => mcp.composedToolName(server.slug, t.name) === call.name);
        const uri = tool?._meta?.ui?.resourceUri;
        if (!uri || !apps.toolVisibleTo(tool, 'model')) return sendJSON(res, 200, { enabled: false });
        const epoch = session.appResourceEpoch;
        const resource = await mcp.readAppResource(projectDir, server.id, uri, { refresh: true });
        if (epoch !== session.appResourceEpoch) throw err('EMCP_APP_STALE', 'MCP App changed during mount; retry');
        const origin = expectedOrigin(req, publicOrigin);
        const policy = buildPolicy(resource._meta.ui, origin);
        if (mounts.size >= 64) throw err('EMCP_APP_LIMIT', 'Too many open MCP Apps');
        const ticket = await sandbox.issue(origin, policy);
        const id = crypto.randomBytes(24).toString('base64url');
        let toolResult;
        try { toolResult = JSON.parse(result.content); } catch { toolResult = { content: [{ type: 'text', text: result.content }] }; }
        const mount = { projectDir, chatId, serverId: server.id, serverSlug: server.slug, uri, session,
          epoch, title: server.name + ' — ' + tool.name, ticket,
          expires: Date.now() + 30 * 60 * 1000, requests: new Map() };
        mounts.set(id, mount);
        return sendJSON(res, 200, { enabled: true, id, url: ticket.url, origin: ticket.origin,
          title: mount.title, html: resource.text, csp: policy.csp, permissions: {},
          arguments: call.args || {}, result: toolResult });
      }
      const match = parsed.pathname.match(/^\/api\/mcp\/apps\/([A-Za-z0-9_-]+)(?:\/(call|status|cancel))?$/);
      if (!match) return sendJSON(res, 404, { error: 'Not found' });
      const id = match[1];
      const mount = mounts.get(id);
      if (req.method === 'DELETE') { dispose(id); return sendJSON(res, 200, { ok: true }); }
      const session = validate(mount);
      if (match[2] === 'status') return sendJSON(res, 200, { ok: true });
      if (match[2] === 'cancel') {
        const request = mount.requests.get(body.requestId);
        if (request) {
          request.controller.abort(); request.done = true;
          try { authz.recordDecision(mount.projectDir, mount.chatId, request.callId, 'deny'); } catch { /* not pending */ }
        }
        return sendJSON(res, 200, { ok: true });
      }
      if (match[2] !== 'call' || req.method !== 'POST') throw err('EBADINPUT', 'Unsupported App operation');
      if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.requestId)) throw err('EBADINPUT', 'requestId is required');
      let request = mount.requests.get(body.requestId);
      if (!request) {
        if (mount.requests.size >= 64) throw err('EMCP_APP_LIMIT', 'MCP App call limit reached; reload');
        const tool = session.tools.find(t => t.name === body.name);
        if (!tool || !apps.toolVisibleTo(tool, 'app')) throw err('EMCP_VISIBILITY', 'Tool is not app-callable on this server');
        if (!body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments)) throw err('EBADINPUT', 'arguments must be an object');
        request = { tool, args: body.arguments, callId: 'mcp_app_' + crypto.randomBytes(12).toString('hex'), controller: new AbortController(), busy: false, done: false };
        mount.requests.set(body.requestId, request);
      }
      if (request.tool.name !== body.name || JSON.stringify(request.args) !== JSON.stringify(body.arguments)) throw err('EBADINPUT', 'Cannot change a pending App call');
      if (request.busy || request.done || request.controller.signal.aborted) throw err('EMCP_APP_GONE', 'App call already executing, completed or cancelled');
      request.busy = true;
      try {
        const toolName = mcp.composedToolName(mount.serverSlug, request.tool.name);
        const authorization = await authz.authorize({ projectDir: mount.projectDir, chatId: mount.chatId,
          callId: request.callId, tool: toolName, args: request.args, flow: 'retry',
          summary: 'MCP App ' + mount.title + ': ' + JSON.stringify(request.args).slice(0, 2048) });
        if (authorization.decision === 'prompt') {
          return sendJSON(res, 409, { code: 'EAUTH_REQUIRED', request: authz.listPending(mount.projectDir, mount.chatId).find(p => p.callId === request.callId) });
        }
        validate(mount);
        const onGone = () => { if (!res.writableEnded) request.controller.abort(); };
        res.on('close', onGone);
        try {
          const out = await mcp.callTool(mount.projectDir, mount.serverSlug, request.tool.name, request.args,
            { caller: 'app', signal: request.controller.signal });
          return sendJSON(res, 200, out);
        } finally {
          request.done = true; res.off('close', onGone);
        }
      } finally { request.busy = false; }
    } catch (e) {
      const status = ['ETOOL_DISABLED', 'EDENIED', 'EMCP_VISIBILITY'].includes(e.code) ? 403
        : e.code === 'EBADINPUT' ? 400 : e.code === 'EMCP_NOTFOUND' ? 404 : 409;
      return sendJSON(res, status, { error: e.message, code: e.code || 'EMCP_APP' });
    }
  }
  async function close() { clearInterval(timer); for (const id of mounts.keys()) dispose(id); await sandbox.close(); }
  return { handle, close, sandbox, mounts };
}
module.exports = { createMcpAppsHost };
