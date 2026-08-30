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
fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026\n', 'utf8');
fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
fs.writeFileSync(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
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
      // The app root intentionally redirects to the canonical /web/ URL.
      // Either a direct 200 (older servers) or that redirect proves the
      // child is accepting HTTP requests.
      if (r.status === 200 || r.status === 302) return true;
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
    t('list flags png as image', list1.body && list1.body.entries.some(e => e.name === 'logo.png' && e.image === true && e.binary === true));
    t('list flags svg as image', list1.body && list1.body.entries.some(e => e.name === 'icon.svg' && e.image === true));
    t('list marks LICENSE as text (sniff)', list1.body && list1.body.entries.some(e => e.name === 'LICENSE' && e.text === true && e.binary === false));

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

    // 4b. read text file with no extension (sniffed as text)
    const r2b = await request('GET', '/api/file?projectDir=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(path.join(root, 'LICENSE')));
    t('read LICENSE 200', r2b.status === 200, JSON.stringify(r2b));
    t('read LICENSE content matches', r2b.body && /MIT License/.test(r2b.body.content || ''));

    // 4c. /api/file-media happy path
    const r2c = await request('GET', '/api/file-media?projectDir=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(path.join(root, 'logo.png')));
    t('media read 200', r2c.status === 200, JSON.stringify(r2c).slice(0, 200));
    t('media mime is image/png', r2c.body && r2c.body.mime === 'image/png');
    t('media dataUrl is image/png base64', r2c.body && /^data:image\/png;base64,/.test(r2c.body.dataUrl || ''));

    // 4d. /api/file-media rejects non-image
    const r2d = await request('GET', '/api/file-media?projectDir=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(path.join(root, 'hello.txt')));
    t('media reject non-image 415', r2d.status === 415, JSON.stringify(r2d));
    t('media reject non-image ENOTIMAGE', r2d.body && r2d.body.code === 'ENOTIMAGE');

    // 5. read escape — with MOUAIF_ALLOW_ANY_ROOT=1 the home cap is lifted,
// so an absolute path outside the project root is now a valid read
// (this is the whole point of the change: browse/edit anywhere under
// home, anywhere at all when allow-any-root is on). The old 403 only
// applies when the path escapes the *home* boundary, which this server's
// env (ALLOW_ANY_ROOT=1) does not enforce.
const r3 = await request('GET', '/api/file?projectDir=' + encodeURIComponent(root) + '&path=' + encodeURIComponent('/etc/hostname'));
t('read above project root succeeds with ALLOW_ANY_ROOT', r3.status === 200, JSON.stringify(r3).slice(0, 200));
t('read above project root has ..-prefixed relPath', r3.body && r3.body.relPath && r3.body.relPath.startsWith('..'));

    // 6. write
    const w1 = await request('PUT', '/api/file', { projectDir: root, path: 'hello.txt', content: 'updated!\n' });
    t('PUT /api/file 200', w1.status === 200, JSON.stringify(w1));
    const persisted = fs.readFileSync(path.join(root, 'hello.txt'), 'utf8');
    t('write persisted', persisted === 'updated!\n');

    // 7. write binary -> 415
    const w2 = await request('PUT', '/api/file', { projectDir: root, path: 'binary.png', content: 'no' });
    t('write binary 415', w2.status === 415, JSON.stringify(w2));

// 8. write escape — with ALLOW_ANY_ROOT=1 a path above the project
// root (but existing in the tree) now succeeds, matching the read
// behaviour above.
const w3 = await request('PUT', '/api/file', { projectDir: root, path: '../.mouaif-http-write-' + Math.random().toString(36).slice(2) + '.txt', content: 'nope' });
t('write above project root succeeds with ALLOW_ANY_ROOT', w3.status === 200, JSON.stringify(w3));
t('write above project root has ..-prefixed relPath', w3.body && w3.body.relPath && w3.body.relPath.startsWith('..'));

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
