// Browser coverage for the durable all-tool mockup, using real renderers.
// Never starts mouaif or accesses real chats, providers, or settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { TOOL_GROUPS } from '../frontend/src/toolGroups.js';
import { TOOL_CASES } from './chat-view-mockup/fixtures.js';
import { serveMockup } from './chat-view-mockup.mjs';
const require = createRequire(import.meta.url);
const { findChrome, createCdp, freePort } = require('./lib/capture-fixture.js');

const nativeNames = TOOL_GROUPS.flatMap(group => group.tools).sort();
assert.equal(new Set(TOOL_CASES.map(test => test.name)).size, TOOL_CASES.length, 'unique examples');
assert.deepEqual(TOOL_CASES.filter(test => nativeNames.includes(test.name)).map(test => test.name).sort(), nativeNames,
  'every native tool has a deliberate fixture; new catalog tools must add one');
const server = await serveMockup();
// Reproduce the exact proxy delivery path used on a phone. No live app,
// authentication bypass, or real authorization endpoint is involved.
const { handlePreviewProxy } = require('../src/previewProxy.js');
let escapedApiRequests = 0;
const proxy = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  if (await handlePreviewProxy(req, res, parsed)) return;
  if (parsed.pathname.startsWith('/api/')) escapedApiRequests++;
  res.writeHead(404); res.end('No app endpoint in this fixture');
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome is required');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-tool-review-'));
  chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 100; i++) {
    try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(p => p.type === 'page'); } catch {}
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Chrome started');
  cdp = await createCdp(page.webSocketDebuggerUrl);
  const exceptions = [];
  // Production renderer failures must fail the review, not silently omit cards.
  await cdp.send('Runtime.enable');
  const evaluate = async expression => {
    const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) { exceptions.push(out.exceptionDetails); throw Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text); }
    return out.result.value;
  };
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.fixtureErrors = [];
    window.addEventListener('error', event => window.fixtureErrors.push(event.message));
    window.addEventListener('unhandledrejection', event => window.fixtureErrors.push(String(event.reason)));
  ` });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  for (let i = 0; i < 100 && !await evaluate('!!window.mockup?.ready'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate('!!window.mockup?.ready'), true, 'review fixture loaded');

  const proxyUrl = 'http://127.0.0.1:' + proxy.address().port + '/api/preview/http/127.0.0.1:' + server.address().port + '/';
  await cdp.send('Page.navigate', { url: proxyUrl });
  for (let i = 0; i < 100 && !await evaluate('!!window.mockup?.ready'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate('!!window.mockup?.ready'), true, 'cards load through the production preview proxy');

  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
    for (const renderPath of ['call-first', 'result-first', 'reconciled']) {
      const result = await evaluate(`(() => {
        const select = document.querySelector('#render-path'); select.value = ${JSON.stringify(renderPath)};
        select.dispatchEvent(new Event('change'));
        return { count: mockup.mounted.length,
          missing: mockup.mounted.filter(item => !item.card || !item.card.classList.contains('is-expanded') || !item.card.querySelector('.tool-card__body')?.textContent.trim()).map(item => item.test.name),
          overflow: mockup.mounted.filter(item => { const r = item.card.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map(item => item.test.name),
          nestedCount: document.querySelectorAll('#tools .tool-card__subagent-toggle').length,
          nestedOpen: [...document.querySelectorAll('#tools .tool-card__subagent-toggle')].every(toggle => toggle.getAttribute('aria-expanded') === 'true'),
          pageFits: document.documentElement.scrollWidth <= innerWidth + 1 };
      })()`);
      assert.equal(result.count, TOOL_CASES.length, 'all examples mounted');
      assert.deepEqual(result.missing, [], 'all expanded bodies have readable content: ' + width + ' ' + renderPath);
      assert.deepEqual(result.overflow, [], 'cards fit: ' + width + ' ' + renderPath);
      assert.ok(result.pageFits, 'no horizontal document overflow');
      assert.ok(result.nestedCount > 0 && result.nestedOpen, 'delegated tool previews start expanded too');
      const replay = await evaluate(`(() => {
        document.querySelector('#collapse').click();
        const collapsed = mockup.mounted.every(item => !item.card.classList.contains('is-expanded'));
        document.querySelector('#reconcile').click();
        const stableClosed = document.querySelector('#review-status').textContent.startsWith('Replay kept');
        document.querySelector('#expand').click(); document.querySelector('#reconcile').click();
        return { collapsed, stableClosed, stableOpen: document.querySelector('#review-status').textContent.startsWith('Replay kept') };
      })()`);
      assert.ok(replay.collapsed && replay.stableClosed && replay.stableOpen, 'replay preserves expanded/collapsed nodes');
    }
    const filter = await evaluate(`(() => {
      const search = document.querySelector('#search'); search.value = 'group_read'; search.dispatchEvent(new Event('input'));
      const visible = mockup.mounted.filter(item => !item.section.hidden).map(item => item.test.name);
      search.value = ''; search.dispatchEvent(new Event('input'));
      const family = document.querySelector('#family'); family.value = 'files'; family.dispatchEvent(new Event('change'));
      const count = mockup.mounted.filter(item => !item.section.hidden).length;
      family.value = 'all'; family.dispatchEvent(new Event('change'));
      return { visible, count };
    })()`);
    assert.deepEqual(filter.visible, ['group_read']);
    assert.equal(filter.count, 7, 'file family filter');
  }

  // Reproduce the reported "change reverted" symptom: an explicit expand
  // during a running call must not be undone by a successful result.
  const transition = await evaluate(`(() => {
    const card = document.querySelector('#state-transition .tool-card');
    // Streaming may auto-expand the card. Close then open to record an
    // explicit user choice, rather than testing the untouched default.
    if (card.classList.contains('is-expanded')) card.querySelector('.tool-card__head').click();
    card.querySelector('.tool-card__head').click();
    const openBefore = card.classList.contains('is-expanded');
    document.querySelector('#state-transition > button').click();
    return { openBefore, openAfter: card.classList.contains('is-expanded'), text: card.textContent };
  })()`);
  assert.ok(transition.openBefore && transition.openAfter, 'user-opened running card stays expanded after success');
  assert.match(transition.text, /Syntax OK/, 'final output replaces live output');

  const interactions = await evaluate(`(async () => {
    const image = document.querySelector('#read-image .tool-card__image-button');
    image.click();
    const lightbox = !!document.querySelector('.image-lightbox');
    document.querySelector('.image-lightbox__close').click();
    document.querySelector('#pending-question .tool-card__ask-preset-chip').click();
    document.querySelector('#pending-approval .tool-card__actions button').click();
    for (let i = 0; i < 100 && (document.querySelector('#pending-approval .tool-card') || document.querySelector('#pending-question .tool-card')); i++) await new Promise(resolve => setTimeout(resolve, 20));
    return { lightbox, closed: !document.querySelector('.image-lightbox'),
      answered: !document.querySelector('#pending-question .tool-card'),
      approved: !document.querySelector('#pending-approval .tool-card') };
  })()`);
  assert.ok(interactions.lightbox && interactions.closed && interactions.answered && interactions.approved,
    'image viewer and isolated question/approval actions work');

  const review = await evaluate(`(() => {
    const body = document.querySelector('#long-command .tool-card__body');
    const head = document.querySelector('#tool-shell .tool-card__head');
    return { longBodyHeight: body.clientHeight, longContentHeight: body.scrollHeight,
      headHeight: head.getBoundingClientRect().height, headTabIndex: head.tabIndex,
      batchHead: document.querySelector('#tool-group_read .tool-card__head').textContent };
  })()`);
  console.log('Review observations: ' + JSON.stringify(review));
  assert.ok(review.longContentHeight > review.longBodyHeight, 'review preserves production overflow instead of hiding it');
  assert.deepEqual(await evaluate('window.fixtureErrors'), [], 'no browser runtime errors');

  const isolation = await fetch('http://127.0.0.1:' + server.address().port + '/api/chats');
  assert.equal(isolation.status, 404, 'preview has no live app API');
  assert.equal(exceptions.length, 0);
  assert.equal(escapedApiRequests, 0, 'fixture interactions never reach an app-origin API');
  console.log('PASS all ' + nativeNames.length + ' native tools + MCP/fallback, production preview proxy, 3 render paths, state retention, filters, isolation, and 360/390/430px widths');
} finally {
  cdp?.close();
  if (chrome) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await exited; }
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
}
