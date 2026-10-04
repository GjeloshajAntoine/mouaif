// Browser regression: normal and search-result chat rows keep identical sizes.
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

const contents = `
import { h, render } from 'preact';
import { ProjectsView } from './frontend/src/components/Projects.jsx';
import './frontend/src/style.css';
const chats = [
  { id: 'title', title: 'needle', matchField: 'title', snippet: 'needle' },
  { id: 'message', title: 'A long chat title '.repeat(12), matchField: 'text', snippet: 'needle matching message '.repeat(24), running: true },
  { id: 'draft', title: 'Draft', matchField: 'draft', snippet: 'needle matching draft '.repeat(24), draftSnippet: 'needle unsent draft '.repeat(12), messageCount: 0, trace: true },
  { id: 'older', title: 'Older chat', matchField: 'text', snippet: 'needle short preview', createdAt: '2020-01-01T09:00:00Z', trace: true, totalCost: { known: true, total: 1234567 } }
].map(chat => ({ createdAt: '2026-01-01T09:00:00Z', messageCount: 4, ...chat }));
window.fetch = async input => {
  const url = new URL(input, location.origin);
  let body = {};
  if (url.pathname === '/api/projects/registered') body = { projects: [{ id: 'fixture', name: 'Fixture', path: '/fixture' }] };
  else if (url.pathname === '/api/chats' || url.pathname === '/api/chats/search') body = { chats, total: chats.length };
  else if (url.pathname === '/api/prompts') body = { prompts: [] };
  else if (url.pathname === '/api/prompt-profiles') body = { profiles: [] };
  else if (url.pathname === '/api/settings/resolved') body = { resolved: {} };
  return new Response(JSON.stringify(body), { status: 200 });
};
render(h(ProjectsView), document.getElementById('fixture'));
`;
const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false,
  outdir: '/tmp/mouaif-chat-row-size-bundle', format: 'esm', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' } });
const files = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/app.css' : '/app.js', file.text]));
const server = http.createServer((req, res) => {
  if (files[req.url]) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(files[req.url]);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="app"><div class="app__shell"><main id="fixture" class="app__main"></main></div></div><script type="module" src="/app.js"></script></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome is required for the layout regression');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-chat-row-size-'));
  chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 100 && await evaluate('document.querySelectorAll(".project-card__chat").length') !== 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await evaluate('document.querySelectorAll(".project-card__chat").length'), 4, 'real component rendered fixture chats');
  const normalHeights = new Map();
  for (const search of [false, true]) {
    if (search) {
      await evaluate(`document.querySelector('.project-card__search-open').click()`);
      await settle();
      await evaluate(`const input = document.querySelector('.project-card__search-input'); input.value = 'needle'; input.dispatchEvent(new Event('input', { bubbles: true }));`);
      for (let i = 0; i < 100 && !await evaluate('!!document.querySelector(".project-card__chat-snippet")'); i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(await evaluate('document.querySelectorAll(".project-card__chat-snippet").length'), 3, 'message and draft snippets rendered');
    }
    for (const width of [360, 390, 430, 768, 1280]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
      for (const fontSize of [16, 20]) {
        await evaluate(`document.documentElement.style.fontSize = '${fontSize}px'`);
        await settle();
        const layout = await evaluate(`(() => {
          const list = document.querySelector('.project-card__chats');
          const rows = [...list.querySelectorAll('.project-card__chat')];
          return { scrolls: list.scrollHeight > list.clientHeight, overflow: list.scrollWidth > list.clientWidth,
            rows: rows.map(row => {
              const box = row.getBoundingClientRect(), button = row.querySelector('button').getBoundingClientRect();
              const main = row.querySelector('.project-card__chat-main').getBoundingClientRect();
              const meta = row.querySelector('.project-card__chat-meta').getBoundingClientRect();
              const snippet = row.querySelector('.project-card__chat-snippet');
              return { height: box.height, width: box.width, buttonHeight: button.height, buttonWidth: button.width,
                fits: main.top >= box.top && main.bottom <= box.bottom && meta.top >= box.top && meta.bottom <= box.bottom && button.top >= box.top && button.bottom <= box.bottom,
                snippetHeight: snippet?.getBoundingClientRect().height, snippetLineHeight: snippet ? parseFloat(getComputedStyle(snippet).lineHeight) : null };
            }) };
        })()`);
        const key = `${width}/${fontSize}`;
        const heights = layout.rows.map(row => row.height);
        assert.ok(heights.every(height => Math.abs(height - heights[0]) < 0.1), `equal row heights (${search ? 'search' : 'normal'}, ${key}): ${heights}`);
        if (!search) normalHeights.set(key, heights[0]);
        else assert.equal(heights[0], normalHeights.get(key), `search preserves normal row height (${key})`);
        assert.ok(layout.rows.every(row => row.width === layout.rows[0].width), 'equal row widths');
        assert.ok(layout.rows.every(row => row.height >= 44 && row.buttonHeight >= 44 && row.buttonWidth >= 44), 'touch targets stay at least 44px');
        assert.ok(layout.rows.every(row => row.fits), 'text and controls do not spill over adjacent rows');
        assert.ok(layout.rows.every(row => row.snippetHeight == null || row.snippetHeight <= row.snippetLineHeight + 0.1), 'snippets occupy only one line');
        assert.equal(layout.scrolls, true, 'capped list scrolls instead of shrinking rows');
        assert.equal(layout.overflow, false, 'no horizontal list overflow');
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'page fits viewport');
      }
    }
  }
  console.log('project card row size: uniform normal/search rows, no overlaps, scrolling and touch targets passed at 360–1280px and enlarged text');
} finally {
  cdp?.close();
  if (chrome) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await exited; }
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
}
