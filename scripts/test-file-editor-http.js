// End-to-end smoke test: spawn the mouaif server on a free port, hit
// the new /api/files and /api/file endpoints, then tear it down.
// Verifies the route wiring (path → handler) and JSON shape over
// real HTTP.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const mouaifHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-http-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-proj-'));
fs.writeFileSync(path.join(root, 'hello.txt'), 'hello world\n', 'utf8');
fs.writeFileSync(path.join(root, 'app.js'), 'const x = 1;\n', 'utf8');
fs.mkdirSync(path.join(root, 'sub'));
fs.writeFileSync(path.join(root, 'sub', 'inner.md'), '# inner\n', 'utf8');
fs.writeFileSync(path.join(root, 'binary.png'), Buffer.from([0, 1, 2, 0xff, 0xfe]));

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
  for (let i = 0; i < 60; i++) {
    try {
      const r = await request('GET', '/');
      if (r.status === 200) return true;
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
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const up = await waitForServer();
  if (!up) { console.error('server failed to start'); child.kill(); process.exit(1); }

  try {
    // 1. list root
    const list1 = await request('GET', '/api/files?projectDir=' + encodeURIComponent(root) + '&dir=' + encodeURIComponent(root));
    t('GET /api/files 200', list1.status === 200, JSON.stringify(list1));
    t('list has hello.txt', list1.body && Array.isArray(list1.body.entries) && list1.body.entries.some(e => e.name === 'hello.txt'));
    t('list has sub/ as dir', list1.body && list1.body.entries.some(e => e.name === 'sub' && e.type === 'dir'));
    t('list flags binary', list1.body && list1.body.entries.some(e => e.name === 'binary.png' && e.binary === true));

    // 2. list a subdir
    const list2 = await request('GET', '/api/files?projectDir=' + encodeURIComponent(root) + '&dir=' + encodeURIComponent(path.join(root, 'sub')));
    t('list sub has inner.md', list2.body && list2.body.entries.some(e => e.name === 'inner.md'));

    // 3. read text
    const r1 = await request('GET', '/api/file?projectDir=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(path.join(root, 'hello.txt')));
    t('GET /api/file 200', r1.status === 200, JSON.stringify(r1));
    t('read content matches', r1.body && r1.body.content === 'hello world\n');

    // 4. read binary -> 415
    const r2 = await request('GET', '/api/file?projectDir=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(path.join(root, 'binary.png')));
    t('read binary 415', r2.status === 415, JSON.stringify(r2));
    t('read binary code EBINARY', r2.body && r2.body.code === 'EBINARY');

    // 5. read escape -> 403
    const r3 = await request('GET', '/api/file?projectDir=' + encodeURIComponent(root) + '&path=' + encodeURIComponent('/etc/passwd'));
    t('read escape 403', r3.status === 403, JSON.stringify(r3));

    // 6. write
    const w1 = await request('PUT', '/api/file', { projectDir: root, path: 'hello.txt', content: 'updated!\n' });
    t('PUT /api/file 200', w1.status === 200, JSON.stringify(w1));
    const persisted = fs.readFileSync(path.join(root, 'hello.txt'), 'utf8');
    t('write persisted', persisted === 'updated!\n');

    // 7. write binary -> 415
    const w2 = await request('PUT', '/api/file', { projectDir: root, path: 'binary.png', content: 'no' });
    t('write binary 415', w2.status === 415, JSON.stringify(w2));

    // 8. write escape -> 403
    const w3 = await request('PUT', '/api/file', { projectDir: root, path: '../escape.txt', content: 'nope' });
    t('write escape 403', w3.status === 403, JSON.stringify(w3));

    // 9. write outside home — projectDir under /tmp
    //     (MOUAIF_ALLOW_ANY_ROOT=1 in env)
    const w4 = await request('PUT', '/api/file', { projectDir: root, path: 'app.js', content: 'const y = 2;\n' });
    t('write project-relative path 200', w4.status === 200, JSON.stringify(w4));
  } finally {
    child.kill('SIGTERM');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
