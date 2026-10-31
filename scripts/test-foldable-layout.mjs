// Browser regression for foldable postures: emulates a hinge through CDP and
// checks that the chat keeps its reading area and its controls on opposite
// sides of it, and that a single screen is unchanged by the posture rules.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const { findChrome, createCdp, freePort } = require('./lib/capture-fixture.js');

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
    import { h, render } from 'preact';
    import { App } from './frontend/src/components/App.jsx';
    import { route } from './frontend/src/api.js';
    import './frontend/src/style.css';
    const project = { id: 'p1', name: 'Fold fixture', path: '/tmp/fold' };
    const messages = Array.from({ length: 30 }, (_, seq) => ({ seq,
      role: seq % 2 ? 'assistant' : 'user', ts: Date.now(),
      content: 'Message ' + seq + ' ' + 'Text that wraps over several lines. '.repeat(12) }));
    window.fetch = async url => {
      const pathname = new URL(String(url), location.href).pathname;
      let body = {};
      if (pathname === '/api/projects') body = { projects: [project] };
      if (pathname === '/api/chats') body = { chats: [{ id: 'c1', name: 'Fold chat' }], total: 1 };
      if (pathname === '/api/chats/c1') body = { chat: { id: 'c1', name: 'Fold chat', tools: null } };
      if (pathname === '/api/chats/c1/messages') body = { messages, total: messages.length, hasMore: false, nextSeq: messages.length };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    window.EventSource = class { close() {} addEventListener() {} };
    route.value = { name: 'chat', chatId: 'c1', projectDir: project.path };
    render(h(App), document.getElementById('app'));
    window.ready = true;
  ` },
  bundle: true, splitting: true, write: false, outdir: '/tmp/mouaif-fold-bundle', format: 'esm',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }
});
const files = {};
for (const file of bundle.outputFiles) {
  const name = path.basename(file.path);
  if (name.endsWith('.css')) files['/app.css'] = (files['/app.css'] || '') + file.text;
  else files[name === 'stdin.js' ? '/app.js' : '/' + name] = file.text;
}
const server = http.createServer((req, res) => {
  const file = files[req.url];
  res.writeHead(200, { 'Content-Type': file ? (req.url.endsWith('.css') ? 'text/css' : 'text/javascript') : 'text/html' });
  res.end(file || '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome is required for the foldable regression');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-fold-'));
  chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 100; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === 'page'); } catch {}
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Chrome started');
  cdp = await createCdp(page.webSocketDebuggerUrl);
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const settle = () => evaluate('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))), 50))');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 100 && !await evaluate('!!document.querySelector(".chat-view__composer-row")'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  await new Promise(resolve => setTimeout(resolve, 300));

  const measure = () => evaluate(`(() => {
    const rect = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const main = document.querySelector('.app__main');
    return { head: rect('.chat-view__head'), transcript: rect('.chat-view__transcript-box'),
      composer: rect('.chat-view__composer-row'), status: rect('.chat-view__status-row'),
      dock: rect('.chat-view__dock'), shell: rect('.app__shell'),
      dockDisplay: getComputedStyle(document.querySelector('.chat-view__dock')).display,
      segments: [matchMedia('(horizontal-viewport-segments: 2)').matches, matchMedia('(vertical-viewport-segments: 2)').matches],
      overflow: main.scrollWidth - main.clientWidth };
  })()`);
  const setScreen = async (width, height, feature) => {
    // `displayFeature` on the metrics override is what Chrome 140 honours;
    // the newer Emulation.setDisplayFeaturesOverride is accepted but leaves
    // the page with one segment.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true,
      ...(feature ? { displayFeature: feature } : {}) });
    await settle();
  };
  // FOLD_SHOTS=<dir> saves a PNG per posture for a visual check.
  const shot = async name => {
    if (!process.env.FOLD_SHOTS) return;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.FOLD_SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  };

  // Single screens: cover and inner panel, flat. The dock wrapper is inert.
  for (const [width, height] of [[344, 882], [690, 830], [830, 690]]) {
    await setScreen(width, height, null);
    const flat = await measure();
    assert.deepEqual(flat.segments, [false, false], `${width}x${height} reports one segment`);
    assert.equal(flat.dockDisplay, 'contents', 'the dock wrapper adds no box on a single screen');
    assert.ok(flat.overflow <= 1, `chat fits horizontally at ${width}px`);
    assert.ok(flat.composer.bottom <= height && flat.transcript.bottom <= flat.composer.top + 1, 'composer sits under the transcript');
    await shot(`flat-${width}x${height}`);
    console.log(`PASS fold flat ${width}x${height}`);
  }

  // Tabletop: hinge across the screen. Seamless (0) and with a seam (24px).
  for (const mask of [0, 24]) {
    const [width, height, offset] = [690, 830, 400];
    await setScreen(width, height, { orientation: 'horizontal', offset, maskLength: mask });
    const t = await measure();
    assert.deepEqual(t.segments, [false, true], 'tabletop reports two stacked segments');
    assert.ok(Math.abs(t.transcript.bottom - offset) <= 1, `transcript ends at the hinge (${t.transcript.bottom} vs ${offset})`);
    assert.ok(t.composer.top >= offset + mask - 1, `composer starts below the hinge (${t.composer.top} vs ${offset + mask})`);
    assert.ok(t.head.bottom <= offset, 'chat head stays in the top half');
    assert.ok(t.status.bottom <= height + 1, 'status row stays on screen');
    assert.ok(t.overflow <= 1, 'tabletop chat fits horizontally');
    await shot(`tabletop-${mask}`);
    console.log(`PASS fold tabletop hinge ${mask}px`);
  }

  // Book: hinge down the screen.
  for (const mask of [0, 24]) {
    const [width, height, offset] = [830, 690, 415 - mask / 2];
    await setScreen(width, height, { orientation: 'vertical', offset, maskLength: mask });
    const b = await measure();
    assert.deepEqual(b.segments, [true, false], 'book reports two side-by-side segments');
    assert.ok(Math.abs(b.shell.left) <= 1 && Math.abs(b.shell.width - width) <= 1, 'frame spans the whole screen');
    assert.ok(b.transcript.right <= offset + 1 && b.head.right <= offset + 1, `head and transcript stay on the left page (${b.transcript.right} vs ${offset})`);
    assert.ok(b.transcript.height > height / 2, 'transcript fills the left page');
    assert.ok(b.composer.left >= offset + mask - 1, `composer sits on the right page (${b.composer.left} vs ${offset + mask})`);
    assert.ok(b.composer.right <= width + 1 && b.status.bottom <= height + 1, 'composer and status stay on screen');
    assert.ok(b.status.bottom >= height - 80, 'composer sits at the foot of the right page');
    assert.ok(b.overflow <= 1, 'book chat fits horizontally');
    await shot(`book-${mask}`);
    console.log(`PASS fold book hinge ${mask}px`);
  }

  // Unfolding again restores the single-screen layout without a reload.
  await setScreen(690, 830, null);
  const back = await measure();
  assert.equal(back.dockDisplay, 'contents', 'flat again after the posture ends');
  assert.ok(back.transcript.bottom <= back.composer.top + 1, 'composer back under the transcript');
  console.log('PASS foldable layout');
} finally {
  cdp?.close();
  chrome?.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (profile) {
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
