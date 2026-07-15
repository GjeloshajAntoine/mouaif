'use strict';

// HTTP end-to-end smoke test for /api/mcp/*. Spawns the mouaif server
// in-process on a free port, drives the REST surface from the same
// process (no PowerShell quoting hell), and tears it down at the end.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-http-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-http-proj-'));
process.env.MOUAIF_HOME = TMP;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const { spawn } = require('child_process');
const serverPath = path.join(__dirname, '..', 'bin', 'mouaif.js');
const proc = null; // set in main()

function fetchJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method,
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

async function waitForServer(port) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetchJson('GET', `http://127.0.0.1:${port}/`);
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

async function main() {
  const PORT = await findFreePort();
  const proc = spawn(process.execPath, [serverPath, 'serve', '--port', String(PORT)], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { MOUAIF_HOME: TMP }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForServer(PORT);
    const base = `http://127.0.0.1:${PORT}`;
    const qp = 'projectDir=' + encodeURIComponent(PROJECT_DIR);
    const srv = path.join(__dirname, 'test-mcp-server.js');

    // 1) List (empty)
    let r = await fetchJson('GET', `${base}/api/mcp/servers?${qp}`);
    check('GET /api/mcp/servers empty', r.status === 200 && Array.isArray(r.body.servers) && r.body.servers.length === 0, JSON.stringify(r));

    // 2) Add
    r = await fetchJson('POST', `${base}/api/mcp/servers`, {
      projectDir: PROJECT_DIR, name: 'Test', command: process.execPath,
      args: [srv], enabled: true
    });
    check('POST /api/mcp/servers adds', r.status === 201 && r.body.server && r.body.server.id, JSON.stringify(r).slice(0, 200));
    const id = r.body.server && r.body.server.id;

    // 3) List (one)
    r = await fetchJson('GET', `${base}/api/mcp/servers?${qp}`);
    check('GET /api/mcp/servers one', r.status === 200 && r.body.servers.length === 1);

    // 4) Start
    r = await fetchJson('POST', `${base}/api/mcp/servers/${encodeURIComponent(id)}/start`, { projectDir: PROJECT_DIR });
    check('POST /start ready', r.status === 200 && r.body.server && r.body.server.status === 'ready', 'status=' + (r.body.server && r.body.server.status));
    check('POST /start discovered tools', r.body.server && Array.isArray(r.body.server.tools) && r.body.server.tools.length === 2);

    // 5) List (ready)
    r = await fetchJson('GET', `${base}/api/mcp/servers?${qp}`);
    check('GET /api/mcp/servers ready', r.body.servers[0].status === 'ready');

    // 6) Call tool via /api/mcp/call
    r = await fetchJson('POST', `${base}/api/mcp/call`, {
      projectDir: PROJECT_DIR, serverId: id, toolName: 'add', args: { a: 7, b: 35 }
    });
    check('POST /api/mcp/call ok', r.status === 200 && r.body.ok === true && r.body.content[0].text === '42', JSON.stringify(r.body));

    // 7) Force refresh tools
    r = await fetchJson('GET', `${base}/api/mcp/servers/${encodeURIComponent(id)}/tools?${qp}`);
    check('GET /tools forces re-discovery', r.status === 200 && r.body.tools.length === 2);

    // 8) Stop
    r = await fetchJson('POST', `${base}/api/mcp/servers/${encodeURIComponent(id)}/stop`, { projectDir: PROJECT_DIR });
    check('POST /stop ok', r.status === 200 && r.body.ok === true);

    // 9) After stop, list shows stopped
    r = await fetchJson('GET', `${base}/api/mcp/servers?${qp}`);
    check('GET /api/mcp/servers stopped', r.body.servers[0].status === 'stopped');

    // 10) PATCH rename
    r = await fetchJson('PATCH', `${base}/api/mcp/servers/${encodeURIComponent(id)}`, {
      projectDir: PROJECT_DIR, name: 'Renamed'
    });
    check('PATCH renames', r.status === 200 && r.body.server && r.body.server.name === 'Renamed');

    // 11) DELETE
    r = await fetchJson('DELETE', `${base}/api/mcp/servers/${encodeURIComponent(id)}?${qp}`);
    check('DELETE removes', r.status === 200 && r.body.ok === true);

    // 12) DELETE again -> 404
    r = await fetchJson('DELETE', `${base}/api/mcp/servers/${encodeURIComponent(id)}?${qp}`);
    check('DELETE missing -> 404', r.status === 404);

    // 13) GET /api/mcp/servers after delete -> empty
    r = await fetchJson('GET', `${base}/api/mcp/servers?${qp}`);
    check('GET /api/mcp/servers empty after delete', r.status === 200 && r.body.servers.length === 0);

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    const code = failed > 0 ? 1 : 0;
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => process.exit(code), 500);
  } catch (e) {
    console.error('Unexpected error:', e);
    try { proc && proc.kill('SIGKILL'); } catch { /* ignore */ }
    process.exit(2);
  }
}

main();
