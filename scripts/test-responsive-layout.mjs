// Browser regression for the real app shell on phones, tablets, and desktops.
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
    import { publish } from './frontend/src/components/chat/webpreviewState.js';
    import './frontend/src/style.css';
    const project = { id: 'p1', name: 'Responsive fixture', path: '/tmp/responsive' };
    const messages = Array.from({ length: 40 }, (_, seq) => ({ seq,
      role: seq % 2 ? 'assistant' : 'user', ts: Date.now(),
      content: 'Message ' + seq + ' ' + 'A readable message on every screen. '.repeat(20) }));
    window.fetch = async url => {
      const pathname = new URL(String(url), location.href).pathname;
      let body = {};
      if (pathname === '/api/projects') body = { projects: [project] };
      if (pathname === '/api/chats') body = { chats: [{ id: 'c1', name: 'Responsive chat' }], total: 1 };
      if (pathname === '/api/chats/c1') body = { chat: { id: 'c1', name: 'Responsive chat', tools: null } };
      if (pathname === '/api/chats/c1/messages') body = { messages, total: messages.length, hasMore: false, nextSeq: messages.length };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    window.EventSource = class { close() {} addEventListener() {} };
    window.mountRoute = name => { route.value = { name, chatId: 'c1', projectDir: project.path }; };
    window.showPreview = () => publish({ thumbnail: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="375" height="667"/>'), url: 'https://example.test' });
    render(h(App), document.getElementById('app'));
    window.ready = true;
  ` },
  bundle: true, splitting: true, write: false, outdir: '/tmp/mouaif-responsive-bundle', format: 'esm',
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
  assert.ok(binary, 'Chrome is required for the responsive regression');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-responsive-'));
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
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 100 && !await evaluate('!!window.ready'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate('!!window.ready'), true, 'app rendered');
  for (const name of ['chats', 'settings', 'settingsDefaults', 'settingsDictation', 'chat']) {
    await evaluate(`window.mountRoute('${name}')`);
    for (let i = 0; i < 100 && !await evaluate('!!document.querySelector(".app__main > section")'); i++) await new Promise(resolve => setTimeout(resolve, 50));
    if (name === 'chat') await evaluate('window.showPreview()');
    await new Promise(resolve => setTimeout(resolve, 200));
    for (const [width, height, fontSize] of [
    ...[360, 390, 430, 768, 900, 1024, 1280, 1920].map(width => [width, 800, 16]),
    [360, 640, 20], [768, 600, 20], [1280, 600, 20], [1920, 900, 20]
    ]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    await evaluate(`document.documentElement.style.fontSize = '${fontSize}px'`);
    await settle();
      const layout = await evaluate(`(() => {
        const rect = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const main = document.querySelector('.app__main');
        return { shell: rect('.app__shell'), main: rect('.app__main'),
          content: rect('.app__main > section'), head: rect('.chat-view__head'),
          composer: rect('.chat-view__composer-row'), transcript: rect('.chat-view__transcript'),
          row: rect('.chat-view__transcript > .chat-msg'), nav: rect('.chat-view__scroll-nav'),
          preview: rect('.webpreview-dock'),
          overflow: main.scrollWidth - main.clientWidth };
      })()`);
      assert.ok(layout.content, `${name} renders its actual view`);
      if (name === 'settingsDictation' && width >= 720) {
      assert.ok(layout.content.width <= 42.5 * fontSize, 'dictation keeps its own readable desktop measure');
      assert.ok(Math.abs(layout.content.left - (width - layout.content.width) / 2) < 1, 'dictation is centred');
      }
      assert.ok(layout.overflow <= 1, `${name} fits horizontally at ${width}px / ${fontSize}px font`);
      assert.ok(Math.abs(layout.shell.width - Math.min(width, 72 * fontSize)) < 1, 'shell grows with the viewport up to its ceiling');
      assert.ok(Math.abs(layout.shell.left - (width - layout.shell.width) / 2) < 1, 'shell is centred');
      assert.ok(layout.main.bottom <= height, 'content stays inside the viewport');
      if (name === 'chat') {
        assert.ok(layout.transcript.height > 200, 'transcript fills available height');
        assert.ok(layout.composer.bottom <= height, 'composer remains visible');
        assert.ok(Math.abs(layout.head.left - layout.composer.left) < 1, 'chat controls share a column');
        if (width >= 48 * fontSize) {
          assert.ok(Math.abs(layout.row.left - layout.head.left) < 1, 'transcript stays centred even with a scrollbar');
          assert.ok(layout.nav.right <= layout.head.right, 'navigation stays beside the conversation, not at the frame edge');
          assert.ok(layout.preview, 'web preview rendered');
          assert.ok(layout.preview.right <= layout.composer.right, 'preview stays above the composer, not at the frame edge');
        }
        if (width <= 430) {
          assert.ok(Math.abs(layout.nav.right - (width - 10)) < 1, 'phone navigation keeps its existing inset');
          assert.ok(Math.abs(layout.preview.right - (width - 0.75 * fontSize)) < 1, 'phone preview keeps its existing inset');
        }
      }
      if (name === 'settingsDefaults') {
        assert.equal(await evaluate(`(() => {
          const section = document.querySelector('.app__main > section');
          section.scrollTop = section.scrollHeight;
          return section.scrollHeight <= section.clientHeight || section.scrollTop > 0;
        })()`), true, 'flush settings still scroll to the bottom');
      }
    }
    console.log('PASS responsive ' + name);
  }
  console.log('PASS responsive app layout');
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
