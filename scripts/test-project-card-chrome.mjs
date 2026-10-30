// Browser regression: the project card's header, ⋯ menu and empty rows.
//   - the header is not styled as a link while it has no action;
//   - the ⋯ menu is fully visible on a card with no chats, and not covered by
//     the next card;
//   - the "No chats yet" row is centred.
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
window.fetch = async input => {
  const url = new URL(input, location.origin);
  let body = {};
  if (url.pathname === '/api/projects/registered') body = { projects: [
    { id: 'one', name: 'One', path: '/fixture/one' },
    { id: 'two', name: 'Two', path: '/fixture/two' }
  ] };
  else if (url.pathname === '/api/chats') body = { chats: [], total: 0 };
  else if (url.pathname === '/api/prompts') body = { prompts: [] };
  else if (url.pathname === '/api/prompt-profiles') body = { profiles: [] };
  else if (url.pathname === '/api/settings/resolved') body = { resolved: {} };
  return new Response(JSON.stringify(body), { status: 200 });
};
render(h(ProjectsView), document.getElementById('fixture'));
`;
const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false,
  outdir: '/tmp/mouaif-card-chrome-bundle', format: 'esm', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' } });
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
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-card-chrome-'));
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
  for (let i = 0; i < 100 && await evaluate('document.querySelectorAll(".project-card__chats-empty").length') !== 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await evaluate('document.querySelectorAll(".project-card__chats-empty").length'), 2, 'both empty cards rendered');
  // Leave the entrance animation out of the measurement, but keep its fill
  // state: it is what puts every card in its own stacking context.
  await evaluate(`document.querySelectorAll('.project-card').forEach(card => card.getAnimations().forEach(animation => animation.finish()))`);
  await settle();

  const failures = [];
  const check = (ok, message) => { if (!ok) failures.push(message); };

  check(await evaluate(`getComputedStyle(document.querySelector('.project-card__identity')).cursor`) !== 'pointer',
    'the header is not styled as a link while it has no action');

  const empty = await evaluate(`(() => {
    const row = document.querySelector('.project-card__chats-empty');
    const range = document.createRange();
    range.selectNodeContents(row);
    const text = range.getBoundingClientRect(), box = row.getBoundingClientRect();
    return { offset: Math.abs((text.left + text.right) / 2 - (box.left + box.right) / 2), cursor: getComputedStyle(row).cursor };
  })()`);
  check(empty.offset < 2, 'the empty-state text is centred in its row (off by ' + empty.offset.toFixed(1) + 'px)');
  check(empty.cursor !== 'pointer', 'the empty-state row is not styled as clickable');

  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    // Open the menu of the FIRST card: the next card sits right below it, so
    // this covers both the card's own clip and the card-over-card stacking.
    await evaluate(`document.querySelector('.project-card__menu-btn:not(.project-card__filter-btn)').click()`);
    await settle();
    const menu = await evaluate(`(() => {
      const pop = document.querySelector('.project-card__menu-pop:not(.project-card__filter-pop)');
      const items = [...pop.querySelectorAll('button')];
      const last = items[items.length - 1].getBoundingClientRect();
      const hit = document.elementFromPoint((last.left + last.right) / 2, (last.top + last.bottom) / 2);
      return { open: !pop.hidden, count: items.length, topmost: hit === items[items.length - 1], bottom: last.bottom };
    })()`);
    // Settings, Rename, Move up, Move down, Unregister (the fixture has two cards).
    check(menu.open && menu.count === 5, 'the menu opens with its five items at ' + width + 'px');
    check(menu.topmost, 'the last menu item (Unregister) is visible and tappable at ' + width + 'px');
    await evaluate(`document.querySelector('.project-card__menu-btn:not(.project-card__filter-btn)').click()`);
    await settle();
  }

  assert.deepEqual(failures, [], 'project card regressions:\n - ' + failures.join('\n - '));
  console.log('project card chrome: header, menu and empty row passed at 360–430px');
} finally {
  cdp?.close();
  if (chrome) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await exited; }
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
}
