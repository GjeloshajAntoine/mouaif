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
    for (let i = 0; i < 100 && (!document.querySelector('#pending-approval [data-decision]') || document.querySelector('#pending-question .tool-card')); i++) await new Promise(resolve => setTimeout(resolve, 20));
    return { lightbox, closed: !document.querySelector('.image-lightbox'),
      answered: !document.querySelector('#pending-question .tool-card'),
      approved: document.querySelector('#pending-approval .tool-card__decision-status')?.textContent === 'Approved' };
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
  const requestFold = await evaluate(`(() => {
    const details = document.querySelector('#long-command details.tool-preview__args');
    const closed = !!details && !details.open;
    details.open = true;
    const body = details.closest('.tool-card__body');
    return { closed, overflows: body.scrollHeight > body.clientHeight };
  })()`);
  assert.ok(requestFold.closed && requestFold.overflows, 'long requests start folded and remain fully readable on expand');
  const accessibility = await evaluate(`(() => {
    const head = document.querySelector('#tool-shell .tool-card__head');
    head.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const closed = head.getAttribute('aria-expanded') === 'false';
    head.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    return { closed, opened: head.getAttribute('aria-expanded') === 'true', height: head.getBoundingClientRect().height, tabIndex: head.tabIndex,
      settings: document.querySelector('#tool-get_settings .tool-card__body').textContent,
      unknown: document.querySelector('#tool-unknown_tool .tool-card__body').textContent };
  })()`);
  assert.ok(accessibility.closed && accessibility.opened && accessibility.height > 0 && accessibility.height <= 36 && accessibility.tabIndex === 0);
  assert.match(accessibility.settings, /promptSize/);
  assert.match(accessibility.unknown, /without a dedicated renderer/);
  assert.match(review.batchHead, /Partial success/);
  assert.deepEqual(await evaluate('window.fixtureErrors'), [], 'no browser runtime errors');

  // Open the exact approval deep link the user receives, through the proxy.
  await cdp.send('Page.navigate', { url: proxyUrl + '?view=approvals' });
  for (let i = 0; i < 100 && !await evaluate('!!window.mockup?.ready'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate('document.querySelector("#view").value'), 'approvals');
  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
    const approvals = await evaluate(`(() => {
      document.querySelector('#reset-approvals').click();
      const entries = mockup.mounted;
      return { count: entries.length,
        nativeCount: entries.filter(item => mockup.nativeNames.includes(item.test.name)).length,
        noPrompt: entries.filter(item => item.section.dataset.approval === 'not-required').map(item => item.test.name),
        questions: entries.filter(item => item.section.dataset.approval === 'question').map(item => item.test.name),
        missingButtons: entries.filter(item => item.section.dataset.approval === 'permission' && item.box.querySelectorAll('button[data-shortcut]').length !== 4).map(item => item.test.name),
        smallButtons: [...document.querySelectorAll('#tools .tool-card__actions button')].filter(button => { const r = button.getBoundingClientRect(); return r.width < 32 || r.height < 28; }).length,
        pageFits: document.documentElement.scrollWidth <= innerWidth + 1,
        modelPicker: !!document.querySelector('#tool-subagent .tool-card__auth-model'),
        statesHidden: document.querySelector('#states').hidden,
        batch: document.querySelector('#tool-group_cli .tool-card__body').textContent,
        folder: document.querySelector('#tool-change_working_folder .tool-card__body').textContent };
    })()`);
    assert.equal(approvals.count, TOOL_CASES.length);
    assert.equal(approvals.nativeCount, nativeNames.length);
    assert.deepEqual(approvals.noPrompt.sort(), ['list_features', 'report_progress']);
    assert.deepEqual(approvals.questions, ['ask_user']);
    assert.deepEqual(approvals.missingButtons, []);
    assert.equal(approvals.smallButtons, 0, 'approval buttons fit in one compact row at ' + width);
    assert.ok(approvals.pageFits && approvals.modelPicker && approvals.statesHidden);
    assert.match(approvals.batch, /1\. node --check/);
    assert.match(approvals.batch, /2\. npm test.*\[background\]/);
    assert.match(approvals.folder, /Chat: demo-chat/);
    assert.match(approvals.folder, /\/demo\/project/);
    const filtered = await evaluate(`(() => {
      const search = document.querySelector('#search'); search.value = 'group_read'; search.dispatchEvent(new Event('input'));
      const visible = mockup.mounted.filter(item => !item.section.hidden).map(item => item.test.name);
      search.value = ''; search.dispatchEvent(new Event('input'));
      return visible;
    })()`);
    assert.deepEqual(filtered, ['group_read'], 'approval examples share search');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await evaluate("!!document.activeElement.closest('#tools .tool-card')"), false,
    'bulk prompts never steal keyboard focus');
  }
  const feedback = await evaluate(`(async () => {
    const card = document.querySelector('#tool-shell .tool-card');
    const once = card.querySelector('[data-shortcut="1"]');
    const always = card.querySelector('[data-shortcut="3"]');
    const scopeTitle = always.title.includes('Always:');
    const deletion = document.querySelector('#tool-delete_chat .tool-card');
    const deleteTarget = deletion.textContent.includes('Review expanded tool states');
    const original = window.fetch;
    let requests = 0, release;
    window.fetch = (input, init) => { requests++; return new Promise(resolve => { release = resolve; }); };
    once.click(); once.click();
    const pending = card.getAttribute('aria-busy') === 'true' && requests === 1 && card.querySelector('.tool-card__decision-status').textContent === 'Sending…';
    release(new Response('{}', { status: 503 }));
    await new Promise(resolve => setTimeout(resolve, 20));
    const failed = !card.dataset.decision && !card.querySelector('button:not([data-shortcut])').hidden && card.textContent.includes('Retry');
    window.fetch = original;
    [...card.querySelectorAll('button')].find(button => button.textContent === 'Retry decision').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    const approved = card.dataset.decision === 'allow-once' && card.querySelector('.tool-card__decision-status').textContent === 'Approved';
    document.querySelector('#reset-approvals').click();
    return { scopeTitle, deleteTarget, pending, failed, approved };
  })()`);
  assert.ok(Object.values(feedback).every(Boolean), 'scope tooltip, deletion target, pending dedupe, failed request and retry feedback');
  const decisions = await evaluate(`(async () => {
    const entries = mockup.mounted.filter(item => item.section.dataset.approval === 'permission');
    for (const [index, item] of entries.entries()) {
      item.box.querySelectorAll('button[data-shortcut]')[index % 4].click();
    }
    const answer = document.querySelector('#tool-ask_user .tool-card__ask-option'); answer.click();
    document.querySelector('#tool-ask_user .tool-card__actions .btn--primary').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const settled = entries.every(item => item.box.querySelector('[data-decision]'));
    const answered = !document.querySelector('#tool-ask_user .tool-card');
    document.querySelector('#reset-approvals').click();
    const reset = document.querySelectorAll('#tools .tool-card--authorization').length === entries.length;
    const view = document.querySelector('#view'); view.value = 'results'; view.dispatchEvent(new Event('change'));
    return { settled, answered, reset, restored: mockup.mounted.every(item => item.card?.classList.contains('is-expanded')) };
  })()`);
  assert.ok(decisions.settled && decisions.answered && decisions.reset && decisions.restored,
    'all demo decisions, question answer, reset, and switching back to results work');
  assert.deepEqual(await evaluate('window.fixtureErrors'), [], 'approval preview has no runtime errors');

  const isolation = await fetch('http://127.0.0.1:' + server.address().port + '/api/chats');
  assert.equal(isolation.status, 404, 'preview has no live app API');
  assert.equal(exceptions.length, 0);
  assert.equal(escapedApiRequests, 0, 'fixture interactions never reach an app-origin API');
  console.log('PASS all ' + nativeNames.length + ' native tools + MCP/fallback, approval gallery/decisions/reset, production preview proxy, 3 render paths, state retention, filters, isolation, and 360/390/430px widths');
} finally {
  cdp?.close();
  if (chrome) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await exited; }
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
}
