'use strict';
const crypto = require('node:crypto');
const chats = require('./chats.js');
const messages = require('./messages.js');
const mcp = require('./mcp.js');
const apps = require('./mcp-apps.js');
const authz = require('./tools/authorization.js');
const { sendJSON, readJsonOr400, expectedOrigin, runningChats, runningKey } = require('./server-shared.js');
const { buildPolicy, createSandboxService } = require('./mcp-apps-sandbox.js');
const { err } = require('./util.js');

function createMcpAppsHost(options = {}, lifecycle = {}) {
  const sandbox = createSandboxService(options);
  const mounts = new Map();
  const messageLimits = new Map(); // project/chat scoped; remount cannot bypass rate limits
  function dispose(id, abandoned) {
    const mount = mounts.get(id) || abandoned;
    if (!mount) return;
    mounts.delete(id);
    sandbox.revoke(mount.ticket.token);
    for (const request of mount.requests.values()) {
      request.controller.abort();
      try { authz.recordDecision(mount.projectDir, mount.chatId, request.callId, 'deny'); } catch { /* not pending */ }
    }
  }
  // A lost browser DELETE must not leave a capability or approval alive.
  // Host polling renews a short lease; absolute expiry is never renewed.
  const timer = setInterval(() => {
    for (const mount of mounts.values()) {
      try { validate(mount); } catch { /* validate revokes invalid mounts */ }
    }
    for (const [key, limit] of messageLimits) if (!limit.busy && limit.at < Date.now() - 60000) messageLimits.delete(key);
  }, 5000);
  timer.unref();

  function validate(mount) {
    try {
      if (!mount || mounts.get(mount.id) !== mount || mount.expires <= Date.now() || mount.lease <= Date.now()) {
        throw err('EMCP_APP_GONE', 'MCP App was closed or expired');
      }
      const server = mcp.listServers(mount.projectDir).find(s => s.id === mount.serverId && s.slug === mount.serverSlug);
      const session = mcp._sessions.get(mount.projectDir + '::' + mount.serverId);
      if (!server || session !== mount.session || session?.status !== 'ready') throw err('EMCP_APP_GONE', 'MCP App server disconnected');
      if (!chats.getChat(mount.projectDir, mount.chatId)) throw err('EMCP_APP_GONE', 'Chat was removed');
      if ((mount.creationTool && authz.effectiveConfig(mount.projectDir, mount.creationTool, mount.chatId).mode === 'off')
      || authz.effectiveConfig(mount.projectDir, mount.sourceTool, mount.chatId).mode === 'off') {
        throw err('ETOOL_DISABLED', 'MCP App source tool is disabled');
      }
      const tool = session.tools.find(t => mcp.composedToolName(server.slug, t.name) === mount.sourceTool);
      if (!apps.toolVisibleTo(tool, 'model') || tool?._meta?.ui?.resourceUri !== mount.uri) {
        throw err('EMCP_APP_STALE', 'MCP App source tool changed; reload');
      }
      if (session.appResourceEpoch !== mount.epoch) throw err('EMCP_APP_STALE', 'MCP App resource changed; reload');
      for (const request of mount.requests.values()) {
      if (request.done || request.controller.signal.aborted) continue;
      const target = session.tools.find(t => t.name === request.tool.name);
      if (!target || !apps.toolVisibleTo(target, 'app')
      || authz.effectiveConfig(mount.projectDir, mcp.composedToolName(server.slug, request.tool.name), mount.chatId).mode === 'off') {
      throw err('ETOOL_DISABLED', 'MCP App requested tool was disabled or removed');
      }
      }
      return session;
    } catch (error) {
      // Authorization may finish after disposal; clear any late prompt too.
      if (mount) dispose(mount.id, mount);
      throw error;
    }
  }

  async function handle(req, res, parsed, publicOrigin) {
    try {
    const origin = expectedOrigin(req, publicOrigin);
    // Keep no-Origin CLI calls, but reject browser cross-site/no-Origin
    // traffic and opaque frames. The ordinary access gate still applies.
    if (!origin || (req.headers.origin !== undefined && req.headers.origin !== origin)
      || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin' && req.headers['sec-fetch-site'] !== 'none')) {
      return sendJSON(res, 403, { error: 'MCP App host origin mismatch', code: 'EORIGIN' });
    }
    const deleting = req.method === 'DELETE' && /^\/api\/mcp\/apps\/[A-Za-z0-9_-]+$/.test(parsed.pathname);
    if (req.method !== 'POST' && !deleting) return sendJSON(res, 405, { error: 'Unsupported App method', code: 'EBADINPUT' });
    const body = await readJsonOr400(req, res);
      if (!body) return;
      if (parsed.pathname === '/api/mcp/apps/mount' && req.method === 'POST') {
        const { projectDir, chatId, callId } = body;
        if (typeof projectDir !== 'string' || typeof chatId !== 'string' || typeof callId !== 'string') throw err('EBADINPUT', 'projectDir, chatId and callId are required');
        if (!chats.getChat(projectDir, chatId)) throw err('EMCP_NOTFOUND', 'Chat not found');
        // The frame identity and original tool input/result come from persisted
        // transcript rows, never server IDs or HTML supplied by the browser.
        const rows = messages.listMessages(projectDir, chatId);
        const call = rows.find(r => r.role === 'tool' && r.phase === 'call' && r.toolCallId === callId);
        const result = rows.find(r => r.role === 'tool' && r.phase === 'result' && r.toolCallId === callId);
        if (!call || !result) throw err('EMCP_NOTFOUND', 'Completed tool call not found');
        let parsedTool = mcp.parseServerSlugAndToolName(call.name);
        let creationTool;
        if (call.name === 'create_mcp_app') {
        // Only a completed native creation result may bind to the fixed
        // trusted adapter. Browser-provided server IDs/HTML remain ignored.
        let created;
        try { created = JSON.parse(result.content); } catch { /* invalid result */ }
        if (created?.ok !== true || !created.server?.id) return sendJSON(res, 200, { enabled: false });
        const entry = mcp.listServers(projectDir).find(s => s.id === created.server.id);
        const path = require('node:path');
        const root = require('./instant-mcp-apps.js').projectRoot(projectDir);
        if (!entry || entry.scope !== 'project' || entry.command !== process.execPath
        || entry.args?.[0] !== path.join(__dirname, 'instant-mcp-app-server.js')
        || entry.args?.[1] !== root || entry.args?.[2] !== created.path) throw err('EBADINPUT', 'Not a trusted local app adapter');
        parsedTool = { serverSlug: entry.slug, toolName: 'view' };
        creationTool = call.name;
        }
        if (!parsedTool) throw err('EBADINPUT', 'Not an MCP tool call');
        const sourceTool = mcp.composedToolName(parsedTool.serverSlug, parsedTool.toolName);
        const server = mcp.listServers(projectDir).find(s => s.slug === parsedTool.serverSlug);
        if (!server) throw err('EMCP_NOTFOUND', 'MCP server not found');
        if (authz.effectiveConfig(projectDir, call.name, chatId).mode === 'off'
        || authz.effectiveConfig(projectDir, sourceTool, chatId).mode === 'off') throw err('ETOOL_DISABLED', 'MCP tool is disabled');
        // Do not silently start stopped servers merely to render old results.
        const session = mcp._sessions.get(projectDir + '::' + server.id);
        const tool = session?.tools.find(t => mcp.composedToolName(server.slug, t.name) === sourceTool);
        const uri = tool?._meta?.ui?.resourceUri;
        if (!uri || !apps.toolVisibleTo(tool, 'model')) return sendJSON(res, 200, { enabled: false });
        const epoch = session.appResourceEpoch;
        const resource = await mcp.readAppResource(projectDir, server.id, uri, { refresh: true });
        if (epoch !== session.appResourceEpoch) throw err('EMCP_APP_STALE', 'MCP App changed during mount; retry');
        const policy = buildPolicy(resource._meta.ui, origin);
        if (mounts.size >= 64) throw err('EMCP_APP_LIMIT', 'Too many open MCP Apps');
        const ticket = await sandbox.issue(origin, policy);
        if (mounts.size >= 64) {
          sandbox.revoke(ticket.token);
          throw err('EMCP_APP_LIMIT', 'Too many open MCP Apps');
        }
        const id = crypto.randomBytes(24).toString('base64url');
        let toolResult;
        try { toolResult = JSON.parse(result.content); } catch { toolResult = { content: [{ type: 'text', text: result.content }] }; }
        const mount = { id, hostOrigin: origin, projectDir, chatId, serverId: server.id, serverSlug: server.slug, uri, session, sourceTool, creationTool,
        epoch, title: server.name + ' — ' + tool.name, ticket,
        expires: Date.now() + 30 * 60 * 1000, lease: Date.now() + 20000, requests: new Map() };
        mounts.set(id, mount);
        validate(mount); // resource read / listener startup may race revocation
        sandbox.bind(ticket.token, () => { validate(mount); });
        return sendJSON(res, 200, { enabled: true, id, url: ticket.url, origin: ticket.origin,
          title: mount.title, html: resource.text, csp: policy.csp, permissions: {},
          arguments: creationTool ? {} : call.args || {}, result: toolResult });
      }
      const match = parsed.pathname.match(/^\/api\/mcp\/apps\/([A-Za-z0-9_-]+)(?:\/(call|status|cancel|message))?$/);
      if (!match) return sendJSON(res, 404, { error: 'Not found' });
      const id = match[1];
      const mount = mounts.get(id);
      if (mount && mount.hostOrigin !== origin) return sendJSON(res, 403, { error: 'MCP App mount origin mismatch', code: 'EORIGIN' });
      if (req.method === 'DELETE') { dispose(id); return sendJSON(res, 200, { ok: true }); }
      const session = validate(mount);
      if (match[2] === 'status') {
      mount.lease = Date.now() + 20000;
      return sendJSON(res, 200, { ok: true });
      }
      if (match[2] === 'message' && req.method === 'POST') {
        // ui/message is app-authored USER text, never assistant/system authority.
        // Only acknowledge acceptance; no conversation or AI response is returned.
        if (body.role !== 'user' || !Array.isArray(body.content) || !body.content.length || body.content.length > 16
          || body.content.some(block => !block || block.type !== 'text' || typeof block.text !== 'string')) {
          throw err('EBADINPUT', 'MCP App messages support user text only');
        }
        const text = body.content.map(block => block.text).join('\n');
        if (!text.trim() || Buffer.byteLength(text, 'utf8') > 16384) throw err('EBADINPUT', 'MCP App message must be non-empty and at most 16 KiB');
        if (body.projectDir !== undefined || body.chatId !== undefined || body.modelId !== undefined || body.providerId !== undefined) {
          throw err('EBADINPUT', 'MCP App cannot select a chat or model');
        }
        const chat = chats.getChat(mount.projectDir, mount.chatId);
        if (!chat.modelId) throw err('EBADINPUT', 'Select a chat model before sending an App message');
        if (runningChats.has(runningKey(mount.projectDir, mount.chatId))) throw err('EALREADY_RUNNING', 'Wait for the current response to finish');
        const key = mount.projectDir + '::' + mount.chatId;
        const now = Date.now();
        const limit = messageLimits.get(key);
        if (limit?.busy || (limit && now - limit.at < 5000)) throw err('EMCP_APP_LIMIT', 'Wait before sending another App message');
        const reservation = { busy: true, at: now };
        messageLimits.set(key, reservation);
        try {
          const started = await require('./server-handlers-chats.js').startChatTurn({
            projectDir: mount.projectDir, chatId: mount.chatId,
            providerId: chat.providerId || '', modelId: chat.modelId,
            thinkingLevel: chat.thinkingLevel || '', maxOutputTokens: chat.maxOutputTokens || '',
            content: '[MCP App: ' + mount.title + ']\n' + text
          }, lifecycle);
          if (!started.ok) throw err(started.code || 'EMCP_APP_MESSAGE', started.error || 'Could not start chat');
          return sendJSON(res, 200, {});
        } finally { reservation.busy = false; }
      }
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
      const currentTool = session.tools.find(t => t.name === request.tool.name);
      if (!currentTool || !apps.toolVisibleTo(currentTool, 'app')) {
        dispose(id);
        throw err('EMCP_VISIBILITY', 'Tool is no longer app-callable on this server');
      }
      if (request.tool.name !== body.name || JSON.stringify(request.args) !== JSON.stringify(body.arguments)) throw err('EBADINPUT', 'Cannot change a pending App call');
      if (request.busy || request.done || request.controller.signal.aborted) throw err('EMCP_APP_GONE', 'App call already executing, completed or cancelled');
      request.busy = true;
      try {
        const toolName = mcp.composedToolName(mount.serverSlug, request.tool.name);
        const authorization = await authz.authorize({ projectDir: mount.projectDir, chatId: mount.chatId,
          callId: request.callId, tool: toolName, args: request.args, flow: 'retry',
          summary: 'MCP App ' + mount.title + ': ' + JSON.stringify(request.args).slice(0, 2048) });
        validate(mount);
        if (request.controller.signal.aborted) {
          try { authz.recordDecision(mount.projectDir, mount.chatId, request.callId, 'deny'); } catch { /* not pending */ }
          throw err('EMCP_APP_GONE', 'App call was cancelled');
        }
        if (authorization.decision === 'prompt') {
          return sendJSON(res, 409, { code: 'EAUTH_REQUIRED', request: authz.listPending(mount.projectDir, mount.chatId).find(p => p.callId === request.callId) });
        }
        validate(mount);
        const onGone = () => { if (!res.writableEnded) request.controller.abort(); };
        res.on('close', onGone);
        try {
          const out = await mcp.callTool(mount.projectDir, mount.serverSlug, request.tool.name, request.args,
            { caller: 'app', signal: request.controller.signal });
          validate(mount); // never return a late result to a revoked view
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
  async function close() { clearInterval(timer); messageLimits.clear(); for (const id of mounts.keys()) dispose(id); await sandbox.close(); }
  return { handle, close, sandbox, mounts };
}
module.exports = { createMcpAppsHost };
