'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-app-host-'));
process.env.MOUAIF_HOME = home;
const { runningChats, runningKey } = require('../src/server-shared.js');
const settings = require('../src/settings.js');
const mcp = require('../src/mcp.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const authz = require('../src/tools/authorization.js');
const { createServer } = require('../src/index.js');
const { buildPolicy } = require('../src/mcp-apps-sandbox.js');
const projectDir = path.join(home, 'project');
fs.mkdirSync(projectDir);
const app = createServer(0);
let releaseUpstream;
const seen = [];
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    seen.push(JSON.parse(raw));
    releaseUpstream = () => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'AI response' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    };
  });
});
let base;
const raw = (url, headers, method = 'POST') => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
    res.resume(); resolve(res.statusCode);
  });
  req.on('error', reject); req.end('{}');
});
const post = async (route, body = {}) => {
  const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
(async () => {
  try {
    assert.throws(() => buildPolicy({ csp: { resourceDomains: ['https://cdn.example.com; connect-src *'] } }, 'http://localhost:5732'), { code: 'EMCP_APP_CSP' });
    assert.throws(() => buildPolicy({ csp: { connectDomains: ['http://127.0.0.1:5732'] } }, 'http://localhost:5732'), { code: 'EMCP_APP_CSP' });
    assert.throws(() => buildPolicy({ csp: { connectDomains: ['https://localhost:5732'] } }, 'http://localhost:5732'), { code: 'EMCP_APP_CSP' });
    assert.throws(() => buildPolicy({ csp: { frameDomains: ['https://example.com'] } }, 'http://localhost:5732'), { code: 'EMCP_APP_CSP' });
    for (const csp of [[], 'fragment', { frameDomains: {} }, { baseUriDomains: {} }, { resourceDomains: [123] }]) {
    assert.throws(() => buildPolicy({ csp }, 'http://localhost:5732'), { code: 'EMCP_APP_CSP' });
    }
    const policy = buildPolicy({}, 'http://localhost:5732');
    assert.match(policy.header, /connect-src 'none'/);
    assert.match(policy.header, /object-src 'none'/);
    assert.doesNotMatch(policy.header, /unsafe-eval/);
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + app.address().port;
    const chat = chats.createChat(projectDir, { title: 'Apps' });
    const server = mcp.addServer(projectDir, { name: 'Apps fixture', command: process.execPath, args: [path.join(__dirname, 'test-mcp-apps-server.js')] });
    await mcp.startServer(projectDir, server.id);
    const name = mcp.composedToolName(server.slug, 'view');
    const callId = 'model_call';
    messages.appendMessage(projectDir, chat.id, { role: 'tool', phase: 'call', toolCallId: callId, name, args: { sample: true }, content: '{}' });
    messages.appendMessage(projectDir, chat.id, { role: 'tool', phase: 'result', toolCallId: callId, name, ok: true, content: JSON.stringify({ content: [{ type: 'text', text: 'fallback' }] }) });
    const body = { projectDir, chatId: chat.id, callId };
    assert.equal((await post('/api/mcp/apps/mount', body)).body.enabled, false);
    settings.setProject(projectDir, { mcpApps: { enabled: true } });
    assert.equal((await post('/api/mcp/apps/mount', { ...body, callId: 'forged' })).status, 404);
    const mounted = await post('/api/mcp/apps/mount', body);
    assert.equal(mounted.status, 200, JSON.stringify(mounted.body));
    const mount = mounted.body;
    assert.equal(mount.enabled, true);
    assert.notEqual(mount.origin, base);
    assert.deepEqual(mount.arguments, { sample: true });
    assert.equal((await fetch(mount.url)).status, 403);
    assert.equal(await raw(mount.url, { Referer: base + '/', Host: 'spoofed.example' }, 'GET'), 403);
    const secret = 'cookie-and-auth-sentinel';
    const proxy = await fetch(mount.url, { headers: { Referer: base + '/', Cookie: 'mouaif_session=' + secret, Authorization: 'Bearer ' + secret } });
    assert.equal(proxy.status, 200);
    assert.match(proxy.headers.get('content-security-policy'), /frame-ancestors/);
    assert.equal(proxy.headers.get('cache-control'), 'no-store');
    assert.equal(proxy.headers.get('set-cookie'), null);
    assert.equal((await proxy.text()).includes(secret), false);
    assert.equal(JSON.stringify([...proxy.headers]).includes(secret), false);
    assert.equal((await fetch(mount.url, { headers: { Referer: base + '/' } })).status, 403, 'ticket cannot be replayed');
    assert.equal((await fetch(mount.origin + '/api/settings')).status, 404);
    const route = '/api/mcp/apps/' + mount.id;
    for (const headers of [{ Origin: 'null' }, { Origin: 'http://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    const res = await fetch(base + route + '/status', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403, JSON.stringify(headers));
    }
    assert.equal((await fetch(base + route + '/status')).status, 405);
    assert.equal(await raw(base + route + '/status', { Host: 'wrong.example' }), 403, 'mount pins exact host origin');
    assert.equal((await post(route + '/call', { requestId: 'bad', name: 'model', arguments: {} })).status, 403);
    const request = { requestId: 'one', name: 'edit', arguments: { text: 'user action' }, serverId: 'forged' };
    const asking = await post(route + '/call', request);
    assert.equal(asking.status, 409);
    assert.equal(asking.body.code, 'EAUTH_REQUIRED');
    assert.match(asking.body.request.summary, /MCP App Apps fixture/);
    assert.equal(asking.body.request.tool, mcp.composedToolName(server.slug, 'edit'));
    assert.equal((await post(route + '/call', { ...request, arguments: { different: true } })).status, 400);
    authz.recordDecision(projectDir, chat.id, asking.body.request.callId, 'allow-once');
    assert.equal((await post(route + '/call', request)).status, 200);
    assert.equal((await post(route + '/call', request)).status, 409);
    const denied = await post(route + '/call', { requestId: 'two', name: 'edit', arguments: {} });
    authz.recordDecision(projectDir, chat.id, denied.body.request.callId, 'deny');
    assert.equal((await post(route + '/call', { requestId: 'two', name: 'edit', arguments: {} })).status, 403);
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    settings.setApp({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + upstream.address().port }] });
    settings.setProject(projectDir, { models: [{ id: 'apps_model', provider: 'openai-compatible' }] });
    chats.updateChat(projectDir, chat.id, { modelId: 'apps_model', providerId: 'openai-compatible' });
    const message = { role: 'user', content: [{ type: 'text', text: 'Explain this chart' }] };
    const usersBefore = messages.listMessages(projectDir, chat.id).filter(r => r.role === 'user').length;
    assert.equal((await post(route + '/message', { ...message, role: 'assistant' })).status, 400);
    assert.equal((await post(route + '/message', { ...message, chatId: 'forged' })).status, 400);
    assert.equal((await post(route + '/message', { role: 'user', content: [{ type: 'image', data: 'bad' }] })).status, 400);
    assert.equal((await post(route + '/message', { role: 'user', content: [{ type: 'text', text: 'x'.repeat(16385) }] })).status, 400);
    assert.equal(messages.listMessages(projectDir, chat.id).filter(r => r.role === 'user').length, usersBefore);
    const accepted = await post(route + '/message', message);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body, {}, 'App receives no conversation or AI response');
    assert.equal((await post(route + '/message', message)).body.code, 'EALREADY_RUNNING', JSON.stringify(messages.listMessages(projectDir, chat.id)));
    for (let i = 0; !releaseUpstream && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert(releaseUpstream, 'automatic App message starts actual provider request');
    assert.match(seen[0].messages.find(r => r.role === 'user').content, /MCP App: Apps fixture/);
    assert.match(messages.listMessages(projectDir, chat.id).find(r => r.role === 'user').content, /Explain this chart/);
    releaseUpstream();
    for (let i = 0; runningChats.has(runningKey(projectDir, chat.id)) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await post(route + '/message', message)).body.code, 'EMCP_APP_LIMIT');
    assert.equal(messages.listMessages(projectDir, chat.id).filter(r => r.role === 'user').length, usersBefore + 1);
    const cancelArgs = { requestId: 'cancelled', name: 'edit', arguments: {} };
    const cancellable = await post(route + '/call', cancelArgs);
    assert.equal(cancellable.status, 409);
    await post(route + '/cancel', { requestId: 'cancelled' });
    assert.equal(authz.listPending(projectDir, chat.id).some(p => p.callId === cancellable.body.request.callId), false);
    assert.equal((await post(route + '/call', cancelArgs)).status, 409);
    await mcp.callTool(projectDir, server.slug, 'view', {});
    assert.equal((await post(route + '/status')).body.code, 'EMCP_APP_STALE');
    await fetch(base + route, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await fetch(mount.url, { headers: { Referer: base + '/' } })).status, 404);
    const fresh = async () => {
    const response = await post('/api/mcp/apps/mount', body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
    };
    const assertRevoked = async (view, code) => {
    const pending = await post('/api/mcp/apps/' + view.id + '/call', { requestId: 'revoke', name: 'edit', arguments: {} });
    assert.equal(pending.body.code, 'EAUTH_REQUIRED');
    return async () => {
      assert.equal((await post('/api/mcp/apps/' + view.id + '/status')).body.code, code);
      assert.equal(authz.listPending(projectDir, chat.id).some(p => p.callId === pending.body.request.callId), false);
      assert.equal((await fetch(view.url, { headers: { Referer: base + '/' } })).status, 404);
    };
    };
    let view = await fresh();
    let check = await assertRevoked(view, 'ETOOL_DISABLED');
    authz.setAuthorization(projectDir, { mcp: { tools: { [name]: { mode: 'off' } } } });
    await check();
    authz.setAuthorization(projectDir, { mcp: { tools: { [name]: { mode: 'ask' } } } });
    view = await fresh(); check = await assertRevoked(view, 'ETOOL_DISABLED');
    settings.setProject(projectDir, { mcpApps: { enabled: false } }); await check();
    settings.setProject(projectDir, { mcpApps: { enabled: true } });
    view = await fresh(); check = await assertRevoked(view, 'EMCP_APP_STALE');
    const liveSession = mcp._sessions.get(projectDir + '::' + server.id);
    const source = liveSession.tools.find(t => t.name === 'view');
    source._meta.ui.visibility = ['app']; await check(); delete source._meta.ui.visibility;
    view = await fresh(); check = await assertRevoked(view, 'EMCP_APP_GONE');
    // No DELETE/status from an abandoned browser: lease expiry clears approval.
    await new Promise(resolve => setTimeout(resolve, 26000));
    assert.equal(authz.listPending(projectDir, chat.id).length, 0);
    await check();
    view = await fresh();
    const originalAuthorize = authz.authorize;
    let resumeAuthorization;
    authz.authorize = async input => {
      await new Promise(resolve => { resumeAuthorization = resolve; });
      return originalAuthorize(input);
    };
    try {
      const inFlight = post('/api/mcp/apps/' + view.id + '/call', { requestId: 'race', name: 'edit', arguments: {} });
      while (!resumeAuthorization) await new Promise(resolve => setTimeout(resolve, 10));
      await fetch(base + '/api/mcp/apps/' + view.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      resumeAuthorization();
      assert.equal((await inFlight).body.code, 'EMCP_APP_GONE');
      assert.equal(authz.listPending(projectDir, chat.id).length, 0, 'late authorization cannot recreate an abandoned approval');
    } finally { authz.authorize = originalAuthorize; resumeAuthorization?.(); }
    view = await fresh(); check = await assertRevoked(view, 'ETOOL_DISABLED');
    const editName = mcp.composedToolName(server.slug, 'edit');
    authz.setAuthorization(projectDir, { mcp: { tools: { [editName]: { mode: 'off' } } } }); await check();
    authz.setAuthorization(projectDir, { mcp: { tools: { [editName]: { mode: 'ask' } } } });
    view = await fresh(); check = await assertRevoked(view, 'EMCP_APP_GONE');
    await mcp.stopServer(projectDir, server.id); await mcp.startServer(projectDir, server.id); await check();
    view = await fresh(); check = await assertRevoked(view, 'EMCP_APP_GONE');
    chats.deleteChat(projectDir, chat.id); await check();
    console.log('PASS MCP Apps actual HTTP routes, opt-in, identity binding, CSP, server-scoped approvals, denial, replay, updates and teardown');
  } finally {
    releaseUpstream?.();
    upstream.closeAllConnections(); if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    await mcp.stopAll(); app.closeAllConnections();
    await new Promise(resolve => app.close(resolve)); settings.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
