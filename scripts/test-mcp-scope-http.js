'use strict';

// In-process HTTP smoke test for the scoped MCP REST surface
// (docs/decisions.md §25). Boots the server in this process on a free
// port (no child spawn) and drives /api/mcp/* with and without a
// projectDir. Exits non-zero on any failure.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-scope-http-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-scope-proj-'));
process.env.MOUAIF_HOME = TMP;

const { createServer } = require('../src/index.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

function fetchJson(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf || '{}'); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const server = createServer(0, { lifecycle: { restarting: false, restart: async () => {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const srv = path.join(__dirname, 'test-mcp-server.js');

  try {
    // 1) App-scope POST without projectDir.
    let r = await fetchJson(port, 'POST', '/api/mcp/servers', {
      scope: 'app', name: 'App Echo', command: process.execPath, args: [srv], enabled: true
    });
    check('POST app server 201', r.status === 201, JSON.stringify(r).slice(0, 200));
    const appId = r.body && r.body.server && r.body.server.id;
    check('app server carries scope app', !!(r.body && r.body.server && r.body.server.scope === 'app'));

    // 2) Project-scope POST without projectDir -> 400.
    r = await fetchJson(port, 'POST', '/api/mcp/servers', {
      name: 'Needs Project', command: process.execPath, args: [srv]
    });
    check('POST project server without projectDir 400', r.status === 400, 'got: ' + r.status);

    // 3) GET without projectDir lists app entries only.
    r = await fetchJson(port, 'GET', '/api/mcp/servers');
    check('GET no projectDir 200', r.status === 200);
    check('GET no projectDir lists app entry', Array.isArray(r.body.servers) && r.body.servers.some(s => s.id === appId && s.scope === 'app'));

    // 4) Project-scope POST with projectDir.
    r = await fetchJson(port, 'POST', '/api/mcp/servers', {
      projectDir: PROJECT_DIR, name: 'Proj Echo', command: process.execPath, args: [srv], enabled: true
    });
    check('POST project server 201', r.status === 201, JSON.stringify(r).slice(0, 200));
    const projId = r.body && r.body.server && r.body.server.id;
    check('project server carries scope project', !!(r.body && r.body.server && r.body.server.scope === 'project'));

    // 5) GET with projectDir returns the merged view (app first).
    const qp = '?projectDir=' + encodeURIComponent(PROJECT_DIR);
    r = await fetchJson(port, 'GET', '/api/mcp/servers' + qp);
    check('GET merged 200 with both', r.status === 200 && r.body.servers.length === 2, 'got: ' + (r.body.servers || []).length);
    check('merged order app then project', r.body.servers[0].scope === 'app' && r.body.servers[1].scope === 'project');

    // 6) Start the app server without a projectDir (App-tab lifecycle).
    r = await fetchJson(port, 'POST', '/api/mcp/servers/' + appId + '/start', {});
    check('start app server 200', r.status === 200, JSON.stringify(r).slice(0, 200));
    check('app server ready without project', r.body && r.body.server && r.body.server.status === 'ready', 'got: ' + (r.body && r.body.server && r.body.server.status));
    check('app server discovered 2 tools', r.body && r.body.server && r.body.server.tools.length === 2);

    // 7) The project-context chat surface sees the app's tools (shared
    //    'app' session context is scanned by listComposedToolSpecs).
    r = await fetchJson(port, 'GET', '/api/tools/list' + qp);
    const toolNames = (r.body && r.body.tools || []).map(t => t.name);
    check('tools/list includes mcp__app_echo__echo', toolNames.includes('mcp__app_echo__echo'), toolNames.filter(n => n.startsWith('mcp__')).join(','));

    // 8) PATCH the app server (disable) via merged view with projectDir.
    r = await fetchJson(port, 'PATCH', '/api/mcp/servers/' + appId, { projectDir: PROJECT_DIR, enabled: false });
    check('PATCH app server via merged view 200', r.status === 200 && r.body.server.enabled === false, JSON.stringify(r).slice(0, 200));

    // 9) DELETE the app server without projectDir.
    r = await fetchJson(port, 'DELETE', '/api/mcp/servers/' + appId);
    check('DELETE app server 200', r.status === 200 && r.body.ok === true);
    r = await fetchJson(port, 'GET', '/api/mcp/servers');
    check('app list empty after delete', r.status === 200 && r.body.servers.length === 0);

    // 10) DELETE the project server.
    r = await fetchJson(port, 'DELETE', '/api/mcp/servers/' + projId + qp);
    check('DELETE project server 200', r.status === 200 && r.body.ok === true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
