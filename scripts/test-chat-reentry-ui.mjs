// Real built app + isolated API fixture at phone widths. No mouaif server restart.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-reentry-ui-'));
const sockets = new Set();
let subscriptions = 0;
let chrome, cdp;
const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const frame = (res, name, data) => res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const p = url.pathname;
  if (p.endsWith('/live')) {
    subscriptions++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    frame(res, 'live_subscribed', { runId: 'fixture-run', count: 0, nextLiveSeq: 0, fromLiveSeq: 0 });
    frame(res, 'live_segment', { text: subscriptions === 1 ? 'Initial partial answer' : 'Initial partial answer plus missed text', reasoning: 'Reasoning restored' });
    const timer = setTimeout(() => frame(res, 'message', { delta: ' + live delta' }), 100);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (p === '/api/access/status') return json(res, { authenticated: true });
  if (p.endsWith('/revision')) return json(res, { running: true, nextSeq: 1 });
  if (p.endsWith('/messages')) return json(res, { messages: url.searchParams.has('fromSeq') ? [] : [{ role: 'user', content: 'Keep working while I am away', seq: 0 }], nextSeq: 1, total: 1, hasMore: false, beforeSeq: 0 });
  if (p === '/api/chats/abcd1234') return json(res, { chat: { id: 'abcd1234', title: 'Running chat', providerId: 'fixture', modelId: 'fixture-model', running: true } });
  if (p.endsWith('/system-prompt')) return json(res, { content: '', agentFilesAvailable: [] });
  if (p === '/api/chats') return json(res, { chats: [{ id: 'abcd1234', title: 'Running chat', running: true }], total: 1 });
  if (p === '/api/ai/models') return json(res, { models: [{ id: 'fixture-model', provider: 'fixture' }] });
  if (p === '/api/ai/models/providers') return json(res, { providers: [{ id: 'fixture', type: 'openai-compatible', label: 'Fixture' }] });
  if (p === '/api/tools/authorization/pending') return json(res, { pending: [] });
  if (p.startsWith('/api/')) return json(res, { app: {}, projects: [], tools: [], servers: [], actions: [], prompts: [], agents: [], models: [] });
  if (p === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); return; }
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
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/#/chat/abcd1234?projectDir=%2Ffixture' });
  for (let i = 0; i < 100; i++) {
    if (await evaluate("document.querySelector('.chat-msg__answer')?.textContent.includes('+ live delta')")) break;
    await sleep(50);
  }
  assert.equal(await evaluate("document.querySelector('.chat-msg__answer')?.textContent.includes('+ live delta')"), true, 'late subscription restores snapshot and appends live delta');
  await sleep(150); // allow native initial pageshow/focus to settle
  const before = subscriptions;
  await evaluate("window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); document.dispatchEvent(new Event('visibilitychange'));");
  for (let i = 0; i < 100; i++) {
    if (await evaluate("document.body.textContent.includes('plus missed text + live delta')")) break;
    await sleep(50);
  }
  assert.equal(subscriptions, before + 1, 'foreground event burst opens only one replacement follower');
  assert.equal(await evaluate("document.body.textContent.includes('plus missed text + live delta')"), true, 'foreground snapshot includes missed text');
  assert.equal(await evaluate("document.querySelectorAll('[data-live=\"1\"]').length"), 1, 'reconnect leaves one live bubble');
  assert.equal(await evaluate("document.body.textContent.includes('Reasoning restored')"), true);
  assert.equal(await evaluate("!!document.querySelector('button[aria-label=\"Stop\"]')"), true, 'stop control remains visible while running');
  assert.deepEqual(await evaluate('window.__fixtureErrors'), [], 'no browser runtime errors');
  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'no page overflow at ' + width);
  }
  console.log('PASS built app restores running chat snapshots/deltas, reconnects once on foreground, and fits 360/390/430 px');
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
