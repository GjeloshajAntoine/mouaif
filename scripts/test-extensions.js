'use strict';
// Extensions (docs/features/extensions.md): the one-file format, the app
// registry (import off, permission summary, on/off, inline server, export,
// delete), the per-project switch, project extensions behind hash trust, and
// extension hooks — including `mcp` hooks against a stub MCP server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-ext-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
delete process.env.MOUAIF_NO_HOOKS;
const projectDir = path.join(root, 'project');
fs.mkdirSync(projectDir, { recursive: true });

const hooks = require('../src/hooks.js');
const extensions = require('../src/extensions.js');
const mcp = require('../src/mcp.js');
const projectHooks = require('../src/projectHooks.js');
const settings = require('../src/settings.js');

const node = JSON.stringify(process.execPath);
const say = (json) => node + ' -e ' + JSON.stringify('process.stdout.write(' + JSON.stringify(JSON.stringify(json)) + ')');
const SERVER = path.join(__dirname, 'test-extension-server.js');

function manifest(extra = {}) {
  return Object.assign({
    mouaifExtension: 1, id: 'ci-watch', name: 'CI watch', version: '0.1.0', description: 'CI state in the chat.',
    permissions: ['chat.read', 'composer.insert'],
    hooks: [{ id: 'ctx', event: 'tool.before', handler: { kind: 'command', command: say({ context: 'from the extension' }) } }],
    ui: [{ id: 'dock', slot: 'chat.dock', title: 'CI', html: '<!doctype html><p>CI</p>' }],
    futureKey: { kept: true }
  }, extra);
}

async function testValidation() {
  assert.throws(() => extensions.validate({ id: 'x', name: 'X' }), /mouaifExtension/);
  assert.throws(() => extensions.validate(manifest({ id: 'Bad Id' })), /id/);
  assert.throws(() => extensions.validate(manifest({ permissions: ['root'] })), /permissions/);
  assert.throws(() => extensions.validate(manifest({ ui: [{ id: 'a', slot: 'sidebar', title: 'A', html: 'x' }] })), /slot/);
  assert.throws(() => extensions.validate(manifest({ ui: [{ id: 'a', slot: 'chat.dock', title: 'A' }] })), /resourceUri or html/);
  assert.throws(() => extensions.validate(manifest({ ui: [{ id: 'a', slot: 'chat.dock', title: 'A', resourceUri: 'ui://x/y' }] })), /server/);
  assert.throws(() => extensions.validate(manifest({ ui: [{ id: 'a', slot: 'tool.renderer', title: 'A', html: 'x' }] })), /match\.tool/);
  assert.throws(() => extensions.validate(manifest({ hooks: [{ id: 'm', event: 'tool.before', handler: { kind: 'mcp', tool: 'x' } }] })), /no server/);
  assert.throws(() => extensions.validate(manifest({ server: { ref: 'srv' }, hooks: [{ id: 'm', event: 'tool.before', handler: { kind: 'mcp', tool: 'x', server: 'other' } }] })), /extension's server/);
  assert.throws(() => extensions.validate(manifest({ server: { name: 'S', command: 'x' } }), { scope: 'project' }), /server\.ref/);
  assert.throws(() => extensions.validate(manifest({ big: 'x'.repeat(1024 * 1024) })), /1 MiB/);
  const ext = extensions.validate(manifest({ server: { ref: 'srv' }, hooks: [{ id: 'm', event: 'tool.before', handler: { kind: 'mcp', tool: 'ci_summary' } }] }));
  assert.equal(ext.hooks[0].handler.server, undefined);
  // Bare mcp hooks name their server.
  assert.throws(() => hooks.normalizeHook({ id: 'm', event: 'tool.before', handler: { kind: 'mcp', tool: 'x' } }), /server/);
}

async function testAppRegistry() {
  const ctx = { projectDir, chatId: 'c1', cwd: projectDir };
  // Imported OFF, with the permission screen's summary.
  const imported = extensions.importApp(manifest());
  assert.equal(imported.extension.enabled, false);
  assert.deepEqual(imported.summary.permissions.map((p) => p.id), ['chat.read', 'composer.insert']);
  assert.equal(imported.summary.hooks[0].id, 'ctx');
  assert.equal((await hooks.runHooks('tool.before', { tool: 'shell', args: {} }, ctx)).notes.length, 0, 'off: no hooks');
  // On: its hooks run, after app hooks, with prefixed ids and the extension id in the env.
  hooks.setConfig({ enabled: true, list: [{ id: 'mine', event: 'tool.before', handler: { kind: 'command', command: say({ context: 'mine' }) } }] });
  extensions.setAppEnabled('ci-watch', true);
  let out = await hooks.runHooks('tool.before', { tool: 'shell', args: {} }, ctx);
  assert.deepEqual(out.notes.map((n) => n.hook), ['mine', 'ci-watch/ctx']);
  assert.equal(out.notes[1].extension, 'ci-watch');
  assert.match(out.context, /from the extension/);
  extensions.importApp(manifest({ hooks: [{ id: 'env', event: 'tool.before', handler: { kind: 'command', shell: 'node', script: 'process.stdout.write(process.env.MOUAIF_EXTENSION_ID || "none")' } }] }));
  extensions.setAppEnabled('ci-watch', true);
  out = await hooks.runHooks('tool.before', { tool: 'shell', args: {} }, ctx);
  assert.match(out.context, /\nci-watch\n/);
  hooks.setConfig({ enabled: true, list: [] });
  // Re-importing turns it off again (new content, new look).
  assert.equal(extensions.importApp(manifest()).replaced, true);
  assert.equal(extensions.list(projectDir).app[0].enabled, false);
  extensions.setAppEnabled('ci-watch', true);
  // The project switch.
  extensions.setProjectOff(projectDir, 'ci-watch', true);
  assert.equal((await hooks.runHooks('tool.before', { tool: 'shell', args: {} }, ctx)).notes.length, 0);
  const listed = extensions.list(projectDir).app[0];
  assert.equal(listed.offInProject, true);
  assert.equal(listed.active, false);
  assert.deepEqual(settings.getProject(projectDir).extensions, { 'ci-watch': { enabled: false } });
  extensions.setProjectOff(projectDir, 'ci-watch', false);
  assert.equal((await hooks.runHooks('tool.before', { tool: 'shell', args: {} }, ctx)).notes.length, 1);
  // Export: the stored file back, unknown keys kept, plus exportedAt.
  const exported = extensions.exportApp('ci-watch');
  assert.ok(exported.exportedAt);
  const { exportedAt, ...rest } = exported;
  void exportedAt;
  assert.equal(JSON.stringify(rest), JSON.stringify(manifest()));
  // Delete.
  assert.equal(extensions.removeApp('ci-watch'), true);
  assert.equal(extensions.list(projectDir).app.length, 0);
}

async function testInlineServerAndMcpHooks() {
  const ctx = { projectDir, chatId: 'c2', cwd: projectDir };
  const m = manifest({
    id: 'ci-mcp',
    server: { name: 'CI ext server', command: process.execPath, args: [SERVER] },
    hooks: [
      { id: 'summary', event: 'tool.before', handler: { kind: 'mcp', tool: 'ci_summary' } },
      { id: 'deny', event: 'tool.before', handler: { kind: 'mcp', tool: 'deny' } }
    ]
  });
  extensions.importApp(m);
  assert.equal(mcp.listServers(projectDir).filter((s) => s.name === 'CI ext server').length, 0, 'not registered while off');
  extensions.setAppEnabled('ci-mcp', true);
  const servers = mcp.listServers(projectDir).filter((s) => s.name === 'CI ext server');
  assert.equal(servers.length, 1, 'turning it on registers its server');
  const out = await hooks.runHooks('tool.before', { tool: 'shell', args: { cmd: 'ls' } }, ctx);
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, 'the CI extension blocks shell');
  assert.match(out.context, /CI green \(tool\.before\)/);
  // An MCP tool error is a hook error.
  extensions.importApp(manifest({ id: 'ci-mcp', server: m.server, hooks: [{ id: 'f', event: 'tool.before', handler: { kind: 'mcp', tool: 'fail' } }] }));
  assert.equal(mcp.listServers(projectDir).filter((s) => s.name === 'CI ext server').length, 0, 're-import unregisters the server');
  extensions.setAppEnabled('ci-mcp', true);
  const err = await hooks.runHooks('tool.before', { tool: 'shell', args: {} }, ctx);
  assert.equal(err.notes[0].decision, 'error');
  assert.match(err.notes[0].error, /server-side failure/);
  // Off and delete remove the server.
  extensions.setAppEnabled('ci-mcp', false);
  assert.equal(mcp.listServers(projectDir).filter((s) => s.name === 'CI ext server').length, 0);
  extensions.setAppEnabled('ci-mcp', true);
  extensions.removeApp('ci-mcp');
  assert.equal(mcp.listServers(projectDir).filter((s) => s.name === 'CI ext server').length, 0);
  // A bare app hook can call a named server too.
  const srv = mcp.addServer(null, { scope: mcp.APP_SCOPE, name: 'Bare server', command: process.execPath, args: [SERVER] });
  hooks.setConfig({ enabled: true, list: [{ id: 'bare', event: 'turn.start', handler: { kind: 'mcp', server: srv.slug, tool: 'echo_args' } }] });
  const bare = await hooks.runHooks('turn.start', { model: 'm1' }, ctx);
  assert.equal(bare.notes[0].decision, 'continue', JSON.stringify(bare.notes));
  hooks.setConfig({ enabled: true, list: [] });
  mcp.removeServer(null, srv.id);
  await mcp.stopAll();
}

async function testProjectExtensions() {
  const ctx = { projectDir, chatId: 'c3', cwd: projectDir };
  const dir = path.join(projectDir, '.mouaif', 'extensions');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'tools', 'ctx.sh'), 'echo project-extension-context\n');
  const file = path.join(dir, 'repo-policy' + extensions.SUFFIX);
  fs.writeFileSync(file, JSON.stringify({ mouaifExtension: 1, id: 'repo-policy', name: 'Repo policy',
    hooks: [{ id: 'ctx', event: 'tool.before', handler: { kind: 'command', command: 'sh ./tools/ctx.sh' } }] }));
  fs.writeFileSync(path.join(dir, 'broken' + extensions.SUFFIX), '{ not json');
  let listed = extensions.list(projectDir).project;
  const item = listed.find((x) => x.id === 'repo-policy');
  assert.equal(item.trusted, false);
  assert.deepEqual(item.files, ['tools/ctx.sh']);
  assert.ok(listed.find((x) => x.id === 'broken').error);
  assert.equal((await hooks.runHooks('tool.before', { tool: 'shell', args: {} }, ctx)).notes.length, 0, 'untrusted: inert');
  assert.throws(() => extensions.trustProject(projectDir, 'repo-policy', 'nope'), /changed/);
  extensions.trustProject(projectDir, 'repo-policy', item.hash);
  let out = await hooks.runHooks('tool.before', { tool: 'shell', args: {} }, ctx);
  assert.deepEqual(out.notes.map((n) => n.hook), ['repo-policy/ctx']);
  assert.equal(out.notes[0].scope, 'project');
  assert.match(out.context, /project-extension-context/);
  // Editing the script it runs makes it inert again.
  fs.writeFileSync(path.join(projectDir, 'tools', 'ctx.sh'), 'echo changed\n');
  extensions.clearCache();
  listed = extensions.list(projectDir).project;
  assert.equal(listed.find((x) => x.id === 'repo-policy').changed, true);
  assert.equal((await hooks.runHooks('tool.before', { tool: 'shell', args: {} }, ctx)).notes.length, 0);
  // A project extension shadows an app extension with the same id.
  extensions.importApp(manifest({ id: 'repo-policy' }));
  extensions.setAppEnabled('repo-policy', true);
  assert.equal((await hooks.runHooks('tool.before', { tool: 'shell', args: {} }, ctx)).notes.length, 0);
  extensions.removeApp('repo-policy');
  extensions.revokeProject(projectDir, 'repo-policy');
  // A project extension cannot register a server.
  fs.writeFileSync(path.join(dir, 'srv' + extensions.SUFFIX), JSON.stringify({ mouaifExtension: 1, id: 'srv', name: 'S', server: { name: 'S', command: 'x' } }));
  assert.match(extensions.list(projectDir).project.find((x) => x.id === 'srv').error, /server\.ref/);
  void projectHooks;
}

// REST: import, list, on/off, export as a download, trust, delete.
async function testRoutes() {
  const { handleExtensions } = require('../src/server-handlers-extensions.js');
  const call = async (method, p, body) => {
    const req = { method, headers: { 'content-type': 'application/json' },
      on(ev, cb) { if (ev === 'data' && body) process.nextTick(() => cb(Buffer.from(JSON.stringify(body)))); if (ev === 'end') process.nextTick(cb); } };
    let status = 0; let text = ''; let headers = {};
    const res = { writeHead(c, h) { status = c; headers = h || {}; }, setHeader() {}, getHeader() {}, write(c) { text += c; }, end(c) { if (c) text += c; } };
    const u = new URL(p, 'http://localhost');
    await handleExtensions(req, res, { pathname: u.pathname, query: Object.fromEntries(u.searchParams) });
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status, body: parsed, headers };
  };
  let r = await call('POST', '/api/extensions', { manifest: manifest() });
  assert.equal(r.status, 200);
  assert.equal(r.body.extension.enabled, false);
  assert.equal((await call('POST', '/api/extensions', { manifest: { nope: 1 } })).status, 400);
  r = await call('GET', '/api/extensions?projectDir=' + encodeURIComponent(projectDir));
  assert.equal(r.body.app[0].id, 'ci-watch');
  assert.ok(r.body.permissions['chat.read']);
  assert.equal((await call('PUT', '/api/extensions/ci-watch', { enabled: true })).body.extension.enabled, true);
  assert.equal((await call('PUT', '/api/extensions/ci-watch', { projectDir, offInProject: true })).status, 200);
  r = await call('GET', '/api/extensions/ci-watch/export');
  assert.equal(r.status, 200);
  assert.match(r.headers['Content-Disposition'], /ci-watch\.mouaif-extension\.json/);
  assert.equal(r.body.futureKey.kept, true);
  assert.equal((await call('PUT', '/api/extensions/nope', { enabled: true })).status, 404);
  assert.equal((await call('DELETE', '/api/extensions/ci-watch')).status, 200);
  const item = extensions.list(projectDir).project.find((x) => x.id === 'repo-policy');
  assert.equal((await call('POST', '/api/extensions/repo-policy/trust', { projectDir, hash: item.hash })).body.extension.trusted, true);
  assert.equal((await call('DELETE', '/api/extensions/repo-policy/trust?projectDir=' + encodeURIComponent(projectDir))).status, 200);
}

// Phase 6: surfaces mount through the MCP Apps host, resolved from the
// registry; chat slots need a chat; permissions gate messages and calls.
async function testSurfaces() {
  const chats = require('../src/chats.js');
  const { createServer } = require('../src/index.js');
  const app = createServer(0);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  const post = async (route, body = {}) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const get = async (route) => { const res = await fetch(base + route); return { status: res.status, body: await res.json() }; };
  try {
    extensions.importApp(manifest({
      id: 'ci-ui',
      server: { name: 'CI ui server', command: process.execPath, args: [SERVER] },
      hooks: [],
      ui: [
        { id: 'dock', slot: 'chat.dock', title: 'CI', html: '<!doctype html><p>dock view</p>', events: ['turn.end'] },
        { id: 'sheet', slot: 'chat.sheet', title: 'CI sheet', resourceUri: 'ui://ci/sheet' },
        { id: 'page', slot: 'settings.page', title: 'CI settings', html: '<!doctype html><p>settings view</p>' }
      ]
    }));
    const chat = chats.createChat(projectDir, { title: 'surfaces' });
    const q = '?projectDir=' + encodeURIComponent(projectDir);
    assert.deepEqual((await get('/api/extensions/surfaces' + q)).body.surfaces, [], 'off: no surfaces');
    assert.equal((await post('/api/mcp/apps/mount', { projectDir, chatId: chat.id, extensionId: 'ci-ui', surfaceId: 'dock' })).status, 404);
    extensions.setAppEnabled('ci-ui', true);
    const listed = (await get('/api/extensions/surfaces' + q)).body.surfaces;
    assert.deepEqual(listed.map((x) => x.surfaceId), ['dock', 'sheet', 'page']);
    assert.deepEqual(listed[0].events, ['turn.end']);
    assert.equal(listed[0].html, undefined, 'the list carries no HTML');
    assert.deepEqual((await get('/api/extensions/surfaces' + q + '&slot=chat.sheet')).body.surfaces.map((x) => x.surfaceId), ['sheet']);

    // Inline html, in a chat.
    let r = await post('/api/mcp/apps/mount', { projectDir, chatId: chat.id, extensionId: 'ci-ui', surfaceId: 'dock' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.enabled, true);
    assert.match(r.body.html, /dock view/);
    assert.equal(r.body.surface.slot, 'chat.dock');
    assert.notEqual(r.body.origin, base);
    const dock = r.body;
    // A chat slot needs a chat; a settings page does not.
    assert.equal((await post('/api/mcp/apps/mount', { projectDir, extensionId: 'ci-ui', surfaceId: 'dock' })).status, 400);
    r = await post('/api/mcp/apps/mount', { projectDir, extensionId: 'ci-ui', surfaceId: 'page' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const page = r.body;
    // A ui:// resource on the extension's server, not declared by any tool.
    r = await post('/api/mcp/apps/mount', { projectDir, chatId: chat.id, extensionId: 'ci-ui', surfaceId: 'sheet' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.html, /CI sheet/);
    const sheet = r.body;
    assert.equal((await post('/api/mcp/apps/mount', { projectDir, chatId: chat.id, extensionId: 'ci-ui', surfaceId: 'nope' })).status, 404);
    // No chat.message permission: no messages. No chat: no server calls.
    r = await post('/api/mcp/apps/' + dock.id + '/message', { role: 'user', content: [{ type: 'text', text: 'hi' }] });
    assert.equal(r.status, 403);
    r = await post('/api/mcp/apps/' + page.id + '/call', { requestId: 'r1', name: 'ci_status', arguments: {} });
    assert.equal(r.status, 403);
    // The sheet can call its server's app-visible tools (authorized in its chat).
    require('../src/tools/authorization.js').setAuthorization(projectDir, { mcp: { tools: { [mcp.composedToolName(mcp.listServers(projectDir).find((s) => s.name === 'CI ui server').slug, 'ci_status')]: { mode: 'allow' } } } });
    r = await post('/api/mcp/apps/' + sheet.id + '/call', { requestId: 'r2', name: 'ci_status', arguments: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.structuredContent, { status: 'green' });
    // Turning the extension off revokes its live views.
    assert.equal((await post('/api/mcp/apps/' + dock.id + '/status')).status, 200);
    extensions.setAppEnabled('ci-ui', false);
    r = await post('/api/mcp/apps/' + dock.id + '/status');
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'EMCP_APP_GONE');
    assert.equal((await post('/api/mcp/apps/' + page.id + '/status')).status, 409);
    extensions.removeApp('ci-ui');
    assert.throws(() => extensions.validate(manifest({ id: 'surfaces' })), /reserved/);
  } finally {
    await new Promise((r) => app.close(r));
    await mcp.stopAll();
  }
}

let finished = false;
process.on('exit', (code) => {
  if (code === 0 && !finished) { console.error('test-extensions: stopped before the end (a promise never settled)'); process.exitCode = 1; }
});

async function main() {
  await testValidation();
  await testAppRegistry();
  await testInlineServerAndMcpHooks();
  await testProjectExtensions();
  await testRoutes();
  await testSurfaces();
  finished = true;
  console.log('test-extensions: ok');
}

main().then(() => {
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
}, (e) => {
  console.error(e);
  mcp.stopAll().catch(() => {}).finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(1);
  });
});
