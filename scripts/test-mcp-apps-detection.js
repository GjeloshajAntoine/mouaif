'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-apps-'));
process.env.MOUAIF_HOME = home;
const settings = require('../src/settings.js');
const mcp = require('../src/mcp.js');
const apps = require('../src/mcp-apps.js');
const project = path.join(home, 'project');
fs.mkdirSync(project);
const uri = 'ui://fixture/view';

(async () => {
  try {
    assert.equal(apps.REVIEWED_REVISION, '82221c0c8ce7661efa6771c9d461511b1650495f');
    assert.deepEqual(apps.normalizeToolMeta({ 'ui/resourceUri': uri }), { ui: { resourceUri: uri } });
    assert.equal(apps.normalizeToolMeta({ ui: { resourceUri: 'https://evil.test' } }), null);
    assert.equal(apps.toolVisibleTo({ _meta: apps.normalizeToolMeta({ ui: { visibility: 'app' } }) }, 'model'), false);
    assert.deepEqual(apps.normalizeToolMeta({ ui: { visibility: ['app', 'bogus', 'app'] } }), { ui: { visibility: ['app'] } });
    const content = { uri, mimeType: apps.MIME_TYPE, text: '<!doctype html><p>app</p>' };
    assert.throws(() => apps.parseUiResource({ contents: [{ ...content, uri: 'ui://other' }] }, uri), { code: 'EMCP_APP_RESOURCE' });
    assert.throws(() => apps.parseUiResource({ contents: [content, content] }, uri), { code: 'EMCP_APP_RESOURCE' });
    assert.throws(() => apps.parseUiResource({ contents: [{ ...content, mimeType: 'text/html' }] }, uri), { code: 'EMCP_APP_RESOURCE' });
    assert.throws(() => apps.parseUiResource({ contents: [{ ...content, text: 'x'.repeat(apps.MAX_HTML_BYTES + 1) }] }, uri), { code: 'EMCP_APP_RESOURCE' });

    const server = mcp.addServer(project, { name: 'Apps fixture', command: process.execPath, args: [path.join(__dirname, 'test-mcp-apps-server.js')] });
    await mcp.startServer(project, server.id);
    const tools = await mcp.listDiscoveredTools(project, server.id);
    assert.equal(tools[0]._meta.ui.resourceUri, uri);
    assert.deepEqual(mcp.listComposedToolSpecs(project).map(t => t.toolName), ['view', 'model']);
    await assert.rejects(mcp.callTool(project, server.slug, 'edit', {}), { code: 'EMCP_VISIBILITY' });
    await assert.rejects(mcp.callTool(project, server.slug, 'model', {}, { caller: 'app' }), { code: 'EMCP_VISIBILITY' });
    assert.equal((await mcp.callTool(project, server.slug, 'edit', {}, { caller: 'app' })).content[0].text, 'text fallback');
    await assert.rejects(mcp.readAppResource(project, server.id, 'ui://other/view'), { code: 'EMCP_NOTFOUND' });
    await assert.rejects(mcp.readAppResource(home, server.id, uri), { code: 'EMCP_NOSESSION' });
    const resource = await mcp.readAppResource(project, server.id, uri);
    assert.match(resource.text, /1/);
    resource.text = 'mutated';
    assert.match((await mcp.readAppResource(project, server.id, uri)).text, /1/);
    const session = mcp._sessions.get(project + '::' + server.id);
    await mcp.callTool(project, server.slug, 'view', {});
    assert.equal(session.appResources.size, 0);
    assert.match((await mcp.readAppResource(project, server.id, uri)).text, /2/);
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(mcp.readAppResource(project, server.id, uri, { signal: ctl.signal }), { code: 'EABORTED' });
    session.tools.push({ name: 'race', _meta: { ui: { resourceUri: 'ui://fixture/race' } } });
    await assert.rejects(mcp.readAppResource(project, server.id, 'ui://fixture/race'), { code: 'EMCP_APP_STALE' });
    session.tools.push({ name: 'slow', _meta: { ui: { resourceUri: 'ui://fixture/slow' } } });
    const inFlight = new AbortController();
    const reading = mcp.readAppResource(project, server.id, 'ui://fixture/slow', { signal: inFlight.signal });
    setTimeout(() => inFlight.abort(), 20);
    await assert.rejects(reading, { code: 'EABORTED' });
    assert.equal(session.appResources.has('ui://fixture/slow'), false);
    for (let i = 0; i < 18; i++) {
      const next = 'ui://fixture/' + i;
      session.tools.push({ name: 'view' + i, _meta: { ui: { resourceUri: next } } });
      await mcp.readAppResource(project, server.id, next);
    }
    assert.equal(session.appResources.size, 16);
    await mcp.stopServer(project, server.id);
    assert.equal(session.appResources.size, 0);
    assert.deepEqual(mcp.listComposedToolSpecs(project).map(t => t.toolName), ['view', 'model']);
    await mcp.startServer(project, server.id);
    assert.match((await mcp.readAppResource(project, server.id, uri)).text, /1/);
    console.log('PASS MCP Apps metadata, visibility, scoped resources, invalidation, race, cancellation, bounds and restart');
  } finally {
    await mcp.stopAll();
    settings.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
