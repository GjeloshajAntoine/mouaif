// Regression: the CLI modal's Tab must complete again after a killed
// full-screen program.
//
// A program that enters the alternate screen and is *killed* (`^C` in less,
// top, htop) never writes the sequence that leaves it. The screen latched
// "full-screen" forever, so the modal kept sending every key as raw bytes at a
// shell that was back at its prompt: Tab never completed anything — the bug
// this test pins down ("the Tab button does nothing").
//
// The shell's own bracketed-paste marker is the fix's signal: when bash prints
// its prompt again it is the line editor that owns stdin, so the screen is left
// alone. The test drives the real built app against a fixture API and asserts
// Tab completes *in the prompt* (nothing is written to the child), and that a
// genuine full-screen program still gets raw bytes.
//
// Real built app + isolated API fixture, no mouaif server restart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { findChrome, createCdp } = require('./lib/capture-fixture.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = findChrome();
assert(chromePath, 'Chrome is required for this browser regression test');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cli-tab-ui-'));
const sockets = new Set();
let chrome, cdp;
let sse = null;
let seq = 0;
// Every command POSTed to the session, in order, as the server saw it.
const posts = [];
const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
// emit(...) — one `cli_output` frame on the /events channel, exactly the shape
// the server broadcasts (see src/server-handlers-tools.js).
const emit = (data, stream) => {
  if (!sse) return;
  seq += 1;
  sse.write('event: cli_output\ndata: ' + JSON.stringify({ id: 'cli_fixture', data, stream: stream || 'stdout', seq }) + '\n\n');
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const p = url.pathname;
  if (p === '/api/access/status') return json(res, { authenticated: true });
  if (p === '/api/tools/cli/session') return json(res, { id: 'cli_fixture', interactive: true, shell: 'bash', projectDir: '/fixture' });
  if (p === '/api/tools/cli/output') return json(res, { chunks: [], dropped: false });
  if (p === '/api/tools/cli/sessions') return json(res, { sessions: [] });
  if (p === '/api/tools/cli/command') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { posts.push(JSON.parse(body)); json(res, { ok: true }); });
    return;
  }
  if (p === '/api/files') return json(res, { entries: [{ name: 'package.json', type: 'file' }, { name: 'src', type: 'dir' }] });
  if (p.endsWith('/revision')) return json(res, { running: false, nextSeq: 1 });
  if (p.endsWith('/messages')) return json(res, { messages: [{ role: 'user', content: 'hi', seq: 0 }], nextSeq: 1, total: 1, hasMore: false, beforeSeq: 0 });
  if (p === '/api/chats/abcd1234') return json(res, { chat: { id: 'abcd1234', title: 'CLI fixture chat', providerId: 'fixture', modelId: 'fixture-model' } });
  if (p.endsWith('/system-prompt')) return json(res, { content: '', agentFilesAvailable: [] });
  if (p === '/api/chats') return json(res, { chats: [{ id: 'abcd1234', title: 'CLI fixture chat' }], total: 1 });
  if (p === '/api/ai/models') return json(res, { models: [{ id: 'fixture-model', provider: 'fixture' }] });
  if (p === '/api/ai/models/providers') return json(res, { providers: [{ id: 'fixture', type: 'openai-compatible', label: 'Fixture' }] });
  if (p === '/api/tools/authorization/pending') return json(res, { pending: [] });
  if (p.startsWith('/api/')) return json(res, { app: {}, projects: [], tools: [], servers: [], actions: [], prompts: [], agents: [], models: [] });
  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': connected\n\n');
    sse = res;
    // A fresh pty shell announcing its prompt: bracketed paste on.
    emit('\x1b[?2004h');
    res.on('close', () => { if (sse === res) sse = null; });
    return;
  }
  const relative = p === '/' ? 'index.html' : p.slice(1);
  const file = path.resolve(root, 'frontend/dist', relative);
  if (!file.startsWith(path.join(root, 'frontend/dist') + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + temp, 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(temp, 'DevToolsActivePort');
  for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await sleep(50);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  cdp = await createCdp(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__fixtureErrors=[]; window.addEventListener('error', e=>window.__fixtureErrors.push(e.message)); window.addEventListener('unhandledrejection', e=>window.__fixtureErrors.push(String(e.reason)));" });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  // type(text) — put a line in the prompt exactly as typing does (the input
  // handler watches the field's own value, so the native setter + input event
  // is the faithful path).
  const type = (text) => evaluate(`(() => { const el = document.querySelector('.cli__prompt'); el.focus(); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const value = () => evaluate("document.querySelector('.cli__prompt').value");
  const keysClass = () => evaluate("document.querySelector('.cli__keys')?.className");
  const hint = () => evaluate("document.querySelector('.cli__hint')?.textContent");
  // tap(label) — touch the on-screen key the way a finger does, so the test
  // goes through the same pointer/touch/mouse/click sequence a phone sends.
  const tapKey = async (label) => {
    const point = await evaluate(`(() => { const b = [...document.querySelectorAll('.cli__key')].find((x) => x.textContent === ${JSON.stringify(label)}); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
    await sleep(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(150);
  };

  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/#/chat/abcd1234?projectDir=%2Ffixture' });
  for (let i = 0; i < 100; i++) {
    if (await evaluate("!!document.querySelector('.file-toolbar__trigger')")) break;
    await sleep(50);
  }
  await evaluate("document.querySelector('.file-toolbar__trigger').click()");
  await sleep(200);
  await evaluate("[...document.querySelectorAll('.file-toolbar__menu-item')].find((b) => /Cli/.test(b.textContent)).click()");
  for (let i = 0; i < 100; i++) {
    if (await evaluate("!!document.querySelector('.cli__prompt')")) break;
    await sleep(50);
  }
  assert.equal(await evaluate("[...document.querySelectorAll('.cli__key')].length"), 12, 'the twelve-key row is rendered');

  // 1. Seed the session history with a command, sent to a shell-owned prompt.
  await type('npm run build');
  await evaluate("document.querySelector('.cli__prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
  await sleep(300);
  assert.equal(posts.length, 1, 'the seed command reached the session');
  assert.equal(posts[0].cmd, 'npm run build');

  // 2. A full-screen program takes the alternate screen, then dies without
  //    restoring it — the case that used to leave the latch on.
  emit('\x1b[?1049h\x1b[2J\x1b[1;1hhtop');
  await sleep(200);
  assert.equal(await keysClass(), 'cli__keys is-prompt', 'a full-screen program puts the rows in program mode');

  await type('y');
  await tapKey('Tab');
  assert.equal(posts.length, 2, 'while a program owns the screen, Tab writes its byte to the child');
  assert.equal(posts[1].cmd, '\t');
  assert.equal(posts[1].raw, true, 'the byte is a raw write, with no line terminator');
  assert.equal(await value(), 'y', 'and a key that writes a byte keeps the draft in the prompt');

  // 3. The program was killed: bash is back at its prompt and says so.
  emit('\x1b[?2004h$ ');
  await sleep(200);
  assert.equal(await keysClass(), 'cli__keys', 'the shell prompt leaves program mode');
  assert.equal(await hint(), 'Tab completes, ↑/↓ recall, ←/→ move in the prompt. ^C stops a command.');

  // 4. The fix: Tab completes in the prompt again, and writes nothing.
  const before = posts.length;
  await type('npm ru');
  await tapKey('Tab');
  assert.equal(await value(), 'npm run build', 'Tab completes in the prompt again after the killed program');
  assert.equal(posts.length, before, 'completion writes nothing to the child');

  await type('package');
  await tapKey('Tab');
  assert.equal(await value(), 'package.json', 'a project name still completes');
  await type('src');
  await tapKey('Tab');
  assert.equal(await value(), 'src/', 'a folder still completes with its slash');
  assert.equal(posts.length, before, 'no completion ever reaches the child');

  assert.deepEqual(await evaluate('window.__fixtureErrors'), [], 'no browser runtime errors');

  // 5. Stays inside a 360 px column, like every other UI surface.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(150);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'no page overflow at 360 px');
  console.log('PASS CLI modal leaves program mode when the shell prompt returns, and Tab completes in the prompt again');
} finally {
  if (cdp) cdp.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill('SIGTERM');
    await exited;
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
