// Regression test: the CLI modal on a project opened through a symlink.
//
// GET /api/tools/cli/session resolves the project path with realpath before
// creating the session, so the session map is keyed by the real directory.
// The command and close handlers used to look the session up by the raw path
// the browser sent — for a symlinked project that never matched, so every
// command answered 404 ENOSESSION and closing the modal left the shell
// running. This drives the real endpoints with the *symlink* path and asserts
// command, close and the post-close state.

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cli-link-'));
const realDir = path.join(base, 'real');
const linkDir = path.join(base, 'link');
fs.mkdirSync(realDir);
fs.symlinkSync(realDir, linkDir, 'dir');

const settings = require('../src/settings.js');
settings.setProject(linkDir, { chats: [] });

const { createServer } = require('../src/index.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

const server = createServer(0);
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  function req(method, url, body) {
    return new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port, method, path: url,
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      r.on('error', reject);
      if (body != null) r.write(JSON.stringify(body));
      r.end();
    });
  }

  (async () => {
    try {
      const session = await req('GET', '/api/tools/cli/session?projectDir=' + encodeURIComponent(linkDir));
      check('session opens on a symlinked project', session.status === 200 && !!session.body.id, 'HTTP ' + session.status);
      check('session reports the resolved directory', session.body.projectDir === fs.realpathSync(linkDir), JSON.stringify(session.body.projectDir));

      const cmd = await req('POST', '/api/tools/cli/command', { projectDir: linkDir, cmd: 'echo hi' });
      check('a command sent with the symlink path reaches the session', cmd.status === 200 && cmd.body.ok === true, 'HTTP ' + cmd.status + ' ' + JSON.stringify(cmd.body));

      const close = await req('POST', '/api/tools/cli/close', { projectDir: linkDir });
      check('close with the symlink path answers ok', close.status === 200);

      // Sessions are reused while alive, so reopening returns the *same* id
      // unless close really killed it — a leaked shell shows up here.
      const reopened = await req('GET', '/api/tools/cli/session?projectDir=' + encodeURIComponent(linkDir));
      check('close really ended the session (reopen starts a new one)',
      reopened.status === 200 && reopened.body.id && reopened.body.id !== session.body.id,
      'first=' + session.body.id + ' reopened=' + (reopened.body && reopened.body.id));
      await req('POST', '/api/tools/cli/close', { projectDir: linkDir });
    } catch (err) {
      failed++;
      console.log('FAIL  unexpected error: ' + (err && err.stack || err));
    }
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    server.close();
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(failed ? 1 : 0);
  })();
});
