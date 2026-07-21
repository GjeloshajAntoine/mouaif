// End-to-end smoke test for the /api/agents routes: spawn the mouaif
// server on a free port, exercise POST (body projectDir), GET (query
// projectDir), PATCH (body projectDir), and DELETE (query projectDir),
// then tear down. Locks in the regression where a top-level
// `projectDir query param is required` 400 rejected POST/PATCH calls
// that carry projectDir in the JSON body.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const mouaifHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-http-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-proj-'));

let pass = 0, fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + msg) : '')); }
}

let port = 0;

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      method, host: '127.0.0.1', port, path: p,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let json; try { json = JSON.parse(b); } catch { json = b; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer() {
  // Any HTTP response (even the 302 / -> /web/ redirect) means the
  // server is up; only a connection error means "not yet".
  for (let i = 0; i < 60; i++) {
    try {
      const r = await request('GET', '/');
      if (typeof r.status === 'number') return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function pickFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function run() {
  port = await pickFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mouaif.js'), 'serve', '--port', String(port), '--host', '127.0.0.1'], {
    env: Object.assign({}, process.env, {
      MOUAIF_HOME: mouaifHome,
      MOUAIF_ALLOW_ANY_ROOT: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  const up = await waitForServer();
  if (!up) { console.error('server failed to start:\n' + serverLog); child.kill(); process.exit(1); }

  try {
    const q = '?projectDir=' + encodeURIComponent(root);

    // POST with projectDir in the body (no query param) — the regression.
    const create = await request('POST', '/api/agents', { projectDir: root, name: 'reviewer', content: 'Review carefully.', tools: ['read_file'] });
    t('POST /api/agents 201 (body projectDir)', create.status === 201, JSON.stringify(create));
    t('created agent has name', create.body && create.body.agent && create.body.agent.name === 'reviewer');

    // POST invalid name -> 400
    const bad = await request('POST', '/api/agents', { projectDir: root, name: 'bad name', content: '' });
    t('POST invalid name 400', bad.status === 400, JSON.stringify(bad));

    // POST duplicate name -> 400
    const dup = await request('POST', '/api/agents', { projectDir: root, name: 'reviewer', content: '' });
    t('POST duplicate name 400', dup.status === 400, JSON.stringify(dup));

    // GET list with query projectDir
    const list = await request('GET', '/api/agents' + q);
    t('GET /api/agents 200', list.status === 200, JSON.stringify(list));
    t('list has reviewer', list.body && Array.isArray(list.body.agents) && list.body.agents.some(a => a.name === 'reviewer'));

    // GET one
    const one = await request('GET', '/api/agents/reviewer' + q);
    t('GET /api/agents/:name 200', one.status === 200 && one.body.agent.content === 'Review carefully.', JSON.stringify(one));

    // GET missing -> 404
    const missing = await request('GET', '/api/agents/ghost' + q);
    t('GET unknown 404', missing.status === 404, JSON.stringify(missing));

    // PATCH with projectDir in the body (no query param) — the regression.
    const patch = await request('PATCH', '/api/agents/reviewer', { projectDir: root, content: 'v2', tools: ['read_file', 'shell'] });
    t('PATCH /api/agents/:name 200 (body projectDir)', patch.status === 200, JSON.stringify(patch));
    t('patch applied content', patch.body && patch.body.agent && patch.body.agent.content === 'v2');
    t('patch applied tools', patch.body && patch.body.agent && patch.body.agent.tools.length === 2);

    // DELETE with query projectDir
    const del = await request('DELETE', '/api/agents/reviewer' + q);
    t('DELETE /api/agents/:name 200', del.status === 200 && del.body.ok === true, JSON.stringify(del));
    const after = await request('GET', '/api/agents' + q);
    t('list empty after delete', after.body && after.body.agents.length === 0);
  } finally {
    child.kill('SIGTERM');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
