'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-instant-apps-'));
process.env.MOUAIF_HOME = home;
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const mcp = require('../src/mcp.js');
const apps = require('../src/instant-mcp-apps.js');
const { createServer } = require('../src/index.js');
const projectDir = path.join(home, 'project');
fs.mkdirSync(projectDir);
const server = createServer(0);
let base;
async function post(route, body, headers = {}) {
  const response = await fetch(base + '/api/mcp/apps/' + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ projectDir, ...body }) });
  return { status: response.status, body: await response.json() };
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    const html = '<!doctype html><html><head><title>Counter</title></head><body><p id="ready">Counter</p></body></html>';
    fs.writeFileSync(path.join(projectDir, 'counter.html'), html);
    const imported = await post('import', { name: 'Counter', path: 'counter.html' });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const entry = imported.body.server;
    assert.equal(entry.scope, 'project');
    assert.equal(entry.status, 'stopped');
    assert.equal(entry.command, process.execPath);
    assert.equal(settings.getProject(projectDir).mcpApps?.enabled, undefined, 'import does not enable apps');
    await mcp.startServer(projectDir, entry.id);
    const tool = (await mcp.listDiscoveredTools(projectDir, entry.id))[0];
    assert.equal(tool.name, 'view');
    assert.equal(tool._meta.ui.resourceUri, 'ui://mouaif/instant-app');
    const resource = await mcp.readAppResource(projectDir, entry.id, tool._meta.ui.resourceUri, { refresh: true });
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.text, /window\.mouaifAppReady/);
    assert.match(resource.text, /id="ready"/);
    assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert(resource.text.indexOf('window.mouaifApp') < resource.text.indexOf('<title>'), 'bridge precedes author modules');
    assert.match((await mcp.callTool(projectDir, entry.slug, 'view', {})).content[0].text, /Counter is ready/);
    fs.writeFileSync(path.join(projectDir, 'counter.html'), html.replace('Counter</p>', 'Updated</p>'));
    assert.match((await mcp.readAppResource(projectDir, entry.id, tool._meta.ui.resourceUri, { refresh: true })).text, /Updated<\/p>/);

    const sentinel = path.join(home, 'never-execute');
    const source = 'document.querySelector("#app").textContent="JS app";\nconst marker="</script>";';
    const uploaded = await post('import', { name: 'Browser JS', filename: 'browser.js', source });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(fs.readFileSync(path.join(projectDir, uploaded.body.path), 'utf8'), source);
    assert(uploaded.body.path.startsWith(apps.APP_DIR + '/'));
    await mcp.startServer(projectDir, uploaded.body.server.id);
    const jsResource = await mcp.readAppResource(projectDir, uploaded.body.server.id, 'ui://mouaif/instant-app');
    assert.match(jsResource.text, /<main id="app">/);
    assert.match(jsResource.text, /<\\\/script>/, 'script end in source cannot break out of module');
    assert.equal((jsResource.text.match(/<script type="module">/g) || []).length, 2, 'SDK and author scope stay separate');
    const nodeSource = 'require("node:fs").writeFileSync(' + JSON.stringify(sentinel) + ', "unsafe");';
    const nodeImported = await post('import', { name: 'Not Node', filename: 'node.js', source: nodeSource });
    await mcp.startServer(projectDir, nodeImported.body.server.id);
    await mcp.callTool(projectDir, nodeImported.body.server.slug, 'view', {});
    assert.equal(fs.existsSync(sentinel), false, 'JS never executes on the server');

    const requested = await post('request', { name: 'Checklist', request: 'A project checklist' });
    assert.equal(requested.status, 201);
    const chat = chats.getChat(projectDir, requested.body.chatId);
    assert.equal(chat.title, 'Build app: Checklist');
    assert.match(chat.draft, /A project checklist/);
    assert(chat.draft.includes(requested.body.path));
    assert.match(chat.draft, /Do not install dependencies/);
    assert.match(chat.draft, /Keep html\/body backgrounds transparent/);
    assert.equal(fs.existsSync(path.join(projectDir, requested.body.path)), false, 'request only prepares a draft');
    assert.equal(mcp.listServers(projectDir).length, 3, 'request does not register a server');

    for (const body of [{}, { path: 'counter.html', source: html }, { path: '../outside.html' },
      { path: path.join(projectDir, 'counter.html') }, { filename: 'app.ts', source: html },
      { filename: 123, source: html }, { source: html },
      { filename: 'app.html', source: '' }, { filename: 'app.html', source: 'x'.repeat(apps.MAX_SOURCE_BYTES + 1) }]) {
      assert.equal((await post('import', body)).status, 400, JSON.stringify(body).slice(0, 160));
    }
    fs.writeFileSync(path.join(home, 'outside.html'), html);
    fs.symlinkSync(path.join(home, 'outside.html'), path.join(projectDir, 'escape.html'));
    assert.equal((await post('import', { path: 'escape.html' })).status, 400);
    const unsafe = path.join(home, 'unsafe-project'); fs.mkdirSync(unsafe);
    fs.symlinkSync(home, path.join(unsafe, '.mouaif'));
    assert.equal((await post('request', { projectDir: unsafe, request: 'test' })).status, 400);
    assert.equal((await post('request', { request: '' })).status, 400);
    assert.equal((await post('request', { request: 'x'.repeat(16001) })).status, 400);
    assert.equal((await post('import', { path: 'counter.html', name: 'x'.repeat(101) })).status, 400);
    for (const headers of [{ Origin: 'null' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await post('import', { path: 'counter.html' }, headers)).status, 403);
    }
    assert.equal((await fetch(base + '/api/mcp/apps/import')).status, 405);
    const native = require('../src/tools/mouaif.js');
    const authz = require('../src/tools/authorization.js');
    const messages = require('../src/messages.js');
    const host = chats.createChat(projectDir, { title: 'Native app host' });
    const opts = { projectDir, chatId: host.id };
    const nativeCreated = await native.runAppTool('create_mcp_app', { name: 'Native app', filename: 'native.html', source: html }, opts);
    assert.equal(nativeCreated.ok, true, nativeCreated.content);
    assert.equal(nativeCreated.result.server.status, 'ready');
    const callId = 'native-app-call';
    messages.appendMessage(projectDir, host.id, { role: 'tool', phase: 'call', name: 'create_mcp_app', toolCallId: callId, content: '{}' });
    messages.appendMessage(projectDir, host.id, { role: 'tool', phase: 'result', name: 'create_mcp_app', toolCallId: callId, content: nativeCreated.content });
    const mounted = await post('mount', { chatId: host.id, callId });
    assert.equal(mounted.status, 200, JSON.stringify(mounted.body));
    assert.equal(mounted.body.enabled, true, 'native creation card mounts the app');
    assert.deepEqual(mounted.body.arguments, {}, 'creation source is not forwarded as view arguments');
    assert.match(mounted.body.html, /Counter/);
    const viewTool = nativeCreated.result.viewTool;
    authz.setAuthorization(projectDir, { tools: { create_mcp_app: { mode: 'off' } } });
    assert.equal((await post(mounted.body.id + '/status', {})).status, 403, 'native Off revokes existing mount');
    assert.equal((await post('mount', { chatId: host.id, callId })).status, 403);
    authz.setAuthorization(projectDir, { tools: { create_mcp_app: { mode: 'ask' } } });
    authz.setAuthorization(projectDir, { mcp: { tools: { [viewTool]: { mode: 'off' } } } });
    assert.equal((await post('mount', { chatId: host.id, callId })).status, 403, 'MCP Off still blocks native app mount');
    authz.setAuthorization(projectDir, { mcp: { tools: { [viewTool]: { mode: 'ask' } } } });
    const serverCount = mcp.listServers(projectDir).length;
    const chatCount = chats.countChats(projectDir);
    for (const args of [{}, { path: 'counter.html', source: html }, { request: 'test', source: html },
    { source: html }, { filename: 'x.ts', source: html }, { filename: 'x.html', source: '' },
    { name: '', path: 'counter.html' }, { request: '' }, { request: 'x'.repeat(16001) },
    { path: '../outside.html' }, { path: 'escape.html' }, { projectDir: home, path: 'counter.html' },
    { filename: 'x.html', source: 'x'.repeat(apps.MAX_SOURCE_BYTES + 1) }]) {
    const out = await native.runAppTool('create_mcp_app', args, opts);
    assert.equal(out.ok, false, JSON.stringify(args).slice(0, 120));
    }
    assert.equal(mcp.listServers(projectDir).length, serverCount, 'invalid calls do not register apps');
    assert.equal(chats.countChats(projectDir), chatCount, 'invalid requests do not create chats');
    const aborted = new AbortController(); aborted.abort();
    assert.equal((await native.runAppTool('create_mcp_app', { path: 'counter.html' }, { ...opts, signal: aborted.signal })).result.code, 'EABORTED');
    assert.equal(mcp.listServers(projectDir).length, serverCount);
    const jsNative = await native.runAppTool('create_mcp_app', { filename: 'native.js', source: nodeSource }, opts);
    assert.equal(jsNative.ok, true);
    await mcp.callTool(projectDir, jsNative.result.server.slug, 'view', {});
    assert.equal(fs.existsSync(sentinel), false, 'native source is never executed in Node');
    const pathNative = await native.runAppTool('create_mcp_app', { path: 'counter.html' }, { ...opts, workingDir: home });
    assert.equal(pathNative.ok, true, 'native paths stay relative to original project');
    assert.equal(pathNative.result.path, 'counter.html');
    const startServer = mcp.startServer;
    try {
    mcp.startServer = async () => { throw Object.assign(new Error('fixture startup failure'), { code: 'EMCP_RPC' }); };
    const failed = await native.runAppTool('create_mcp_app', { path: 'counter.html' }, opts);
    assert.equal(failed.ok, false);
    assert.equal(failed.result.ok, false);
    assert.equal(failed.result.code, 'EMCP_RPC');
    assert.ok(mcp.listServers(projectDir).some(entry => entry.id === failed.result.server.id), 'start error retains recoverable registered server');
    assert.equal(failed.result.path, 'counter.html');
    } finally { mcp.startServer = startServer; }
    assert.equal((await fetch(base + '/')).status, 200, 'existing frontend serve flow');
    console.log('PASS instant MCP Apps imports, official SDK injection, stdio discovery, JS isolation, request drafts, bounds and traversal/origin guards');
  } finally {
    await mcp.stopAll();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    settings.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
