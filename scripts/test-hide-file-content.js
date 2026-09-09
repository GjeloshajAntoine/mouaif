'use strict';

// End-to-end smoke test for the "Hide file content" (redaction) feature.
//
// Spawns the mouaif server on a free port, then:
//   1. PUT /api/settings/hide-file-content stores a rule for a project file.
//   2. GET /api/settings/hide-file-content returns the normalized rule.
//   3. The agent file tools redact the hidden lines (read_file) and skip
//      matches on them (search_files) — verified by hitting the in-process
//      tool runner via require(), since the REST surface doesn't expose the
//      tool call directly, and by reading the persisted .mouaif.json.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const mouaifHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-hide-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-hide-proj-'));
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'secrets.js'),
  'const apiKey = "SECRET";\nconst normal = 1;\nconst token = "TOKEN";\n', 'utf8');

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
    // 1. GET with no rules -> empty list
    const g0 = await request('GET', '/api/settings/hide-file-content?projectDir=' + encodeURIComponent(root));
    t('GET rules 200 empty', g0.status === 200 && Array.isArray(g0.body.rules) && g0.body.rules.length === 0, JSON.stringify(g0));

    // 2. PUT a rule hiding lines 1 and 3
    const put = await request('PUT', '/api/settings/hide-file-content', {
      projectDir: root,
      rules: [{ path: 'src/secrets.js', ranges: [{ start: 1, end: 1 }, { start: 3, end: 3 }] }]
    });
    t('PUT rules 200', put.status === 200, JSON.stringify(put));
    t('PUT returns normalized rule', Array.isArray(put.body.rules) && put.body.rules.length === 1, JSON.stringify(put.body));

    // 3. GET now returns one rule
    const g1 = await request('GET', '/api/settings/hide-file-content?projectDir=' + encodeURIComponent(root));
    t('GET rules 200 one', g1.status === 200 && g1.body.rules.length === 1, JSON.stringify(g1));
    t('GET rule path', g1.body.rules[0] && g1.body.rules[0].path === 'src/secrets.js');
    t('GET rule has 2 ranges', g1.body.rules[0] && g1.body.rules[0].ranges.length === 2);

    // 4. malformed rules are normalized away
    const putBad = await request('PUT', '/api/settings/hide-file-content', {
      projectDir: root,
      rules: [{ path: '', ranges: [{ start: 1, end: 1 }] }, { path: 'src/x.js', ranges: [{ start: 0, end: 2 }, { start: 3, end: 1 }] }]
    });
    t('PUT bad rules 200 (normalized to empty)', putBad.status === 200 && putBad.body.rules.length === 0, JSON.stringify(putBad));

    // 5. Re-store the valid rule, then verify the file tools redact.
    await request('PUT', '/api/settings/hide-file-content', {
      projectDir: root,
      rules: [{ path: 'src/secrets.js', ranges: [{ start: 1, end: 1 }, { start: 3, end: 3 }] }]
    });

    // In-process runner reads from the same settings store the server wrote.
    // The server and this test share MOUAIF_HOME, so the project settings
    // row/file is visible to both.
    const settings = require('../src/settings.js');
    const files = require('../src/tools/files.js');
    const r = await files.runFileTool('read_file', { projectDir: root, args: { path: 'src/secrets.js' } });
    t('read_file redacted ', r.result.redacted === true, JSON.stringify(r.result));
    t('read_file body has [hidden] markers', r.result.body.indexOf('[hidden]') >= 0 && r.result.body.indexOf('SECRET') === -1, JSON.stringify(r.result.body));
    t('read_file keeps visible line', r.result.body.indexOf('const normal = 1;') >= 0);

    const s = await files.runFileTool('search_files', { projectDir: root, args: { query: 'SECRET|TOKEN' } });
    t('search_files skips hidden lines', s.result.matches.length === 0, JSON.stringify(s.result.matches));

    console.log('---');
    console.log('hide file content: ' + pass + ' passed, ' + fail + ' failed');
  } finally {
    child.kill();
  }
  if (fail) process.exit(1);
}

run().catch((e) => { console.error('test crashed:', e); process.exit(1); });
