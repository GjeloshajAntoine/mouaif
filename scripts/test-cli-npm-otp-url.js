// Regression test: npm's 2FA link must reach the CLI modal complete.
//
// `npm publish` under web 2FA prints a one-time link
// `https://www.npmjs.com/auth/cli/<uuid>`. When stdin or stdout is not a
// terminal, npm prints it through its error path, whose log redactor masks
// every UUID — so the user saw `https://www.npmjs.com/auth/cli/***` and could
// not authenticate. With a real terminal npm uses its prompt path, which
// prints the link unredacted.
//
// This drives a real `npm publish` inside a real CLI session over the HTTP +
// SSE endpoints, against a local fake registry that demands web OTP, and
// renders the frames through the modal's own CliScreen. It runs once per
// pseudo-terminal backend present on the host (util-linux `script`, the
// python3 fallback, ...), so a host that only has one of them is covered too.
//
// Skips (exit 0) when npm is not on PATH or the host has no PTY backend
// (Windows).

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pty = require('../src/pty.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (spawnSync('npm', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.log('SKIP  npm is not on PATH');
  process.exit(0);
}
pty._resetForTests();
if (!pty.isAvailable()) {
  console.log('SKIP  no pseudo-terminal backend on this host (Windows)');
  process.exit(0);
}

const AUTH_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const AUTH_URL = 'https://www.npmjs.com/auth/cli/' + AUTH_ID;

// A registry that answers the first publish with a web-OTP challenge and
// immediately completes the done-URL poll, so npm finishes on its own.
function startRegistry() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.startsWith('/-/v1/done')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ token: '123456' }));
      }
      if (req.method === 'PUT' && !req.headers['npm-otp']) {
        res.writeHead(401, { 'www-authenticate': 'OTP', 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          authUrl: AUTH_URL,
          doneUrl: 'http://127.0.0.1:' + server.address().port + '/-/v1/done?authId=' + AUTH_ID
        }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function makePackage(registryPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-npm-otp-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mouaif-otp-probe', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, '.npmrc'),
    '//127.0.0.1:' + registryPort + '/:_authToken=fake\nregistry=http://127.0.0.1:' + registryPort + '/\n');
  return dir;
}

async function runOnce(backend, registry, CliScreen) {
  pty._resetForTests([backend]);
  const dir = makePackage(registry.address().port);
  require('../src/settings.js').setProject(dir, { chats: [] });
  const { createServer } = require('../src/index.js');
  const server = createServer(0);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (method, url, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve({}); } });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });

  const session = await req('GET', '/api/tools/cli/session?projectDir=' + encodeURIComponent(dir));
  const screen = new CliScreen();
  let raw = '';
  let buf = '';
  const events = http.request({ host: '127.0.0.1', port, path: '/events' }, (res) => {
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
        if (d && d.id === session.id && d.stream !== 'exit') { raw += d.data; screen.write(d.data); }
      }
    });
    res.on('error', () => {});
  });
  events.on('error', () => {});
  events.end();
  await sleep(400);

  // --browser=false: print the link instead of trying to open a browser.
  await req('POST', '/api/tools/cli/command', { projectDir: dir, cmd: 'npm publish --browser=false; echo PUBLISH-DONE=$?' });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !/PUBLISH-DONE=\d/.test(raw)) await sleep(150);

  const text = screen.render();
  const tag = '[' + backend + '] ';
  check(tag + 'session runs on a pseudo-terminal', session.interactive === true, JSON.stringify(session));
  check(tag + 'the 2FA link is printed in full', text.includes(AUTH_URL), JSON.stringify(text.slice(-600)));
  check(tag + 'the link is never masked as ***', !/auth\/cli\/\*\*\*/.test(text), JSON.stringify(text.slice(-600)));
  check(tag + 'npm completes the publish after the web login', /PUBLISH-DONE=0/.test(raw), JSON.stringify(text.slice(-300)));

  await req('POST', '/api/tools/cli/close', { projectDir: dir });
  events.destroy();
  await new Promise((r) => server.close(r));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

(async () => {
  const { CliScreen } = await import('../frontend/src/components/chat/utils.js');
  const registry = await startRegistry();
  try {
    const backends = ['script (util-linux)', 'script (BSD)', 'python3 pty'].filter((name) => {
      pty._resetForTests([name]);
      return pty.isAvailable();
    });
    for (const backend of backends) await runOnce(backend, registry, CliScreen);
  } catch (err) {
    failed++;
    console.log('FAIL  unexpected error: ' + (err && err.stack || err));
  }
  pty._resetForTests();
  registry.close();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
