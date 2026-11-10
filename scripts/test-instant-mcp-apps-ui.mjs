import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { connectAppCdp } from './lib/mcp-apps-cdp.mjs';
const require = createRequire(import.meta.url);
const { findChrome } = require('./lib/capture-fixture.js');
const { renderHtml } = require('../src/instant-mcp-apps.js');
const { createSandboxService, buildPolicy } = require('../src/mcp-apps-sandbox.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-instant-ui-'));
const sandbox = createSandboxService();
let currentLabel = 'initialized';
const makeHtml = () => renderHtml(`
  document.querySelector('#app').innerHTML = '<p id="ready">waiting</p><p id="incoming"></p><button id="message">Send text</button>';
  window.mouaifApp.addEventListener('toolresult', params => {
    const text = params?.content?.[0]?.text || '';
    if (text && text !== 'ready') document.querySelector('#incoming').textContent = text;
  });
  window.mouaifAppReady.then(() => document.querySelector('#ready').textContent = ${JSON.stringify(currentLabel)});
  document.querySelector('#message').onclick = async () => {
    await window.mouaifApp.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Single-file message' }] });
    document.querySelector('#ready').textContent = 'accepted';
  };
`, 'js', 'Single-file app');
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
  import { h, render } from 'preact';
  import { InstantMcpApp } from './frontend/src/components/settings/InstantMcpApp.jsx';
  import { appendMessageToTranscript, appendToolCallCard, appendToolResultCard, prependOlderTranscript, renderTranscript } from './frontend/src/components/chat/transcript.js';
  render(h(InstantMcpApp, { projectDir: '/fixture', onImported: () => window.imported = true }), document.querySelector('#form'));
  const root = document.querySelector('#frame');
  const refs = { transcript: { current: root }, pinnedToBottom: { current: false }, pendingCount: { current: 0 },
    jumpBtn: { current: null }, usageSummary: { current: null }, _suspendScrollPin: true,
    mcpAppContext: { projectDir: '/fixture', chatId: 'chat' } };
  window.sendAgentMessageToApp = text => {
    appendToolCallCard({ id: 'agent-msg', name: 'create_mcp_app', args: { name: 'Single-file app', message: text } }, refs);
    appendToolResultCard({ id: 'agent-msg', name: 'create_mcp_app', ok: true,
      result: { ok: true, mode: 'message', name: 'Single-file app', message: text, content: [{ type: 'text', text }] } }, refs);
    appendMessageToTranscript({ role: 'assistant', content: 'Agent reply after message', ts: new Date().toISOString() }, false, refs, { chat: {} });
  };
  window.updateNativeAppInPlace = () => {
    appendToolCallCard({ id: 'native-update', name: 'create_mcp_app', args: { name: 'Single-file app v2', path: 'app.js', source: 'updated' } }, refs);
    appendToolResultCard({ id: 'native-update', name: 'create_mcp_app', ok: true,
      result: { ok: true, updated: true, name: 'Single-file app v2', path: 'app.js', content: [{ type: 'text', text: 'updated' }] } }, refs);
    appendMessageToTranscript({ role: 'assistant', content: 'App was updated in place', ts: new Date().toISOString() }, false, refs, { chat: {} });
  };
  window.createSecondApp = () => {
    appendToolCallCard({ id: 'second-create', name: 'create_mcp_app', args: { name: 'Second app', filename: 'second.js' } }, refs);
    appendToolResultCard({ id: 'second-create', name: 'create_mcp_app', ok: true,
      result: { ok: true, name: 'Second app', path: 'second.js', content: [{ type: 'text', text: 'ready' }] } }, refs);
    appendMessageToTranscript({ role: 'assistant', content: 'Second app is ready', ts: new Date().toISOString() }, false, refs, { chat: {} });
  };
  // Any MCP App, not only on-the-fly ones: a server tool's card mounts its view
  // when it is expanded.
  window.addServerAppTool = id => {
    appendToolCallCard({ id, name: 'mcp__srv__view', args: {} }, refs);
    appendToolResultCard({ id, name: 'mcp__srv__view', ok: true, result: { content: [{ type: 'text', text: 'ok' }] } }, refs);
    appendMessageToTranscript({ role: 'assistant', content: 'After ' + id, ts: new Date().toISOString() }, false, refs, { chat: {} });
  };
  // Rows of a persisted chat, for the paths that paint history.
  const rowText = id => ({ role: 'assistant', content: 'Row ' + id, ts: '2026-01-01T00:00:00.000Z', seq: id });
  const appRows = id => [
    { role: 'tool', phase: 'call', toolCallId: id, name: 'create_mcp_app', args: { name: id }, ts: '2026-01-01T00:00:00.000Z' },
    { role: 'tool', phase: 'result', toolCallId: id, name: 'create_mcp_app', ok: true, args: { name: id },
      content: JSON.stringify({ ok: true, name: id, path: id + '.js' }), ts: '2026-01-01T00:00:00.000Z' }
  ];
  const historyRoot = id => {
    const host = document.createElement('div');
    host.id = id;
    document.body.appendChild(host);
    return { transcript: { current: host }, pinnedToBottom: { current: false }, pendingCount: { current: 0 },
      jumpBtn: { current: null }, usageSummary: { current: null }, setupCard: { current: null }, systemPromptCard: { current: null },
      toolsCard: { current: null }, skillsCard: { current: null }, agentFilesCard: { current: null },
      mcpAppContext: { projectDir: '/fixture', chatId: 'chat' } };
  };
  const historyState = messages => ({ messages, chat: {}, props: { projectDir: '/fixture', chatId: 'chat' } });
  // Two apps in one older page, oldest first, with nothing newer on screen.
  window.prependTwoApps = () => {
    const page = historyRoot('prepend');
    appendMessageToTranscript({ role: 'assistant', content: 'Tail row', ts: '2026-01-01T00:00:00.000Z' }, false, page, { chat: {} });
    prependOlderTranscript(historyState([]), page, [...appRows('page-a'), rowText('between'), ...appRows('page-b')]);
    prependOlderTranscript(historyState([]), page, [...appRows('page-older')]);
    window.prependPage = page;
  };
  window.createOnPrependPage = () => {
    appendToolCallCard({ id: 'page-live', name: 'create_mcp_app', args: { name: 'live' } }, window.prependPage);
    appendToolResultCard({ id: 'page-live', name: 'create_mcp_app', ok: true, result: { ok: true, name: 'live', path: 'live.js' } }, window.prependPage);
  };
  // An app that opens its page: it has nothing above it until an older page
  // lands, and must still go back between that page and the rows below it.
  window.prependFirstRowApp = () => {
    const page = historyRoot('first-row');
    appendMessageToTranscript({ role: 'assistant', content: 'Tail row', ts: '2026-01-01T00:00:00.000Z' }, false, page, { chat: {} });
    prependOlderTranscript(historyState([]), page, [...appRows('first-a')]);
    prependOlderTranscript(historyState([]), page, [rowText('older')]);
    appendToolCallCard({ id: 'first-live', name: 'create_mcp_app', args: { name: 'live' } }, page);
    appendToolResultCard({ id: 'first-live', name: 'create_mcp_app', ok: true, result: { ok: true, name: 'live', path: 'live2.js' } }, page);
  };
  // A long chat: both apps sit in the backfilled history, above the tail.
  window.renderLongChat = () => {
    const page = historyRoot('backfill');
    const messages = [];
    for (let i = 0; i < 5; i++) messages.push(rowText(1000 + i));
    messages.push(...appRows('fill-a'), rowText(1100), ...appRows('fill-b'));
    for (let i = 0; i < 60; i++) messages.push(rowText(2000 + i));
    renderTranscript(historyState(messages), page);
  };
  appendToolCallCard({ id: 'native-create', name: 'create_mcp_app', args: { name: 'Single-file app', filename: 'app.js' } }, refs);
  appendToolResultCard({ id: 'native-create', name: 'create_mcp_app', ok: true,
    result: { ok: true, name: 'Single-file app', path: 'app.js', content: [{ type: 'text', text: 'ready' }] } }, refs);
  appendMessageToTranscript({ role: 'assistant', content: 'App is ready below', ts: new Date().toISOString() }, false, refs, { chat: {} });
  window.nativeCard = root.querySelector('[data-tool-id="native-create"]');
  window.nativeAutoExpanded = window.nativeCard.classList.contains('is-expanded') && !!root.querySelector('.mcp-app')
    && root.lastElementChild === window.nativeCard;
` }, bundle: true, write: false, outdir: '/tmp/instant-ui', format: 'esm' });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
let base, chrome, cdp;
const imports = [], requests = [], appMessages = [], mounts = [];
const server = http.createServer(async (req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url.startsWith('/api/mcp/apps/sandbox/')) return sandbox.handleProxy(req, res, req.url.slice('/api/mcp/apps/sandbox/'.length));
  if (req.url === '/api/mcp/apps/import') {
    imports.push(JSON.parse(raw)); return json(201, { name: 'On-the-fly app', path: 'counter.js' });
  }
  if (req.url === '/api/mcp/apps/request') {
    requests.push(JSON.parse(raw)); return json(201, { chatId: 'devchat', path: '.mouaif/mcp-apps/unique.html' });
  }
  if (req.url === '/api/mcp/apps/mount') {
    mounts.push(JSON.parse(raw));
    const ticket = await sandbox.issue(base, buildPolicy({}, base));
    return json(200, { enabled: true, id: 'fixture', title: 'Single-file app', html: makeHtml(), ...ticket, csp: {},
      arguments: {}, result: { path: 'app.js', content: [{ type: 'text', text: 'ready' }] } });
  }
  if (req.url === '/api/mcp/apps/fixture/message') { appMessages.push(JSON.parse(raw)); return json(200, {}); }
  if (req.url.startsWith('/api/')) return json(200, { ok: true });
  if (req.url === '/fixture.js' || req.url === '/fixture.css') {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.js') ? 'application/javascript' : 'text/css' });
    return res.end(req.url.endsWith('.js') ? js : css);
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:*" });
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="form"></div><div id="frame"></div><script type="module" src="/fixture.js"></script>');
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  assert(findChrome(), 'Chrome is required');
  chrome = spawn(findChrome(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + temp, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; !fs.existsSync(path.join(temp, 'DevToolsActivePort')) && i < 100; i++) await sleep(50);
  const port = fs.readFileSync(path.join(temp, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  cdp = await connectAppCdp(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.attachFrames();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.navigate', { url: base });
  for (let i = 0; i < 100 && !await cdp.evaluate("!!document.querySelector('#instant-mcp-app-mode')"); i++) await sleep(50);
  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal overflow at ' + width);
    assert.equal(await cdp.evaluate("[...document.querySelectorAll('.instant-mcp-app input,.instant-mcp-app select,.instant-mcp-app button')].every(e=>e.getBoundingClientRect().height>=44)"), true, 'touch targets at ' + width);
  }
  await cdp.evaluate("const mode=document.querySelector('#instant-mcp-app-mode');mode.value='file';mode.dispatchEvent(new Event('change',{bubbles:true}));");
  await sleep(50);
  await cdp.evaluate("const input=document.querySelector('#instant-mcp-app-path'); input.value='counter.js';input.dispatchEvent(new Event('input',{bubbles:true}));");
  await sleep(50);
  await cdp.evaluate("document.querySelector('.instant-mcp-app button').click()");
  for (let i = 0; !imports.length && i < 100; i++) await sleep(50);
  assert.deepEqual(imports, [{ projectDir: '/fixture', name: 'On-the-fly app', path: 'counter.js' }], 'form serializes JSON');
  // Receiving the request is earlier than parsing its response and calling
  // onImported; wait for the callback, not just the fixture's request log.
  for (let i = 0; !await cdp.evaluate('window.imported') && i < 100; i++) await sleep(50);
  assert.equal(await cdp.evaluate('window.imported'), true);
  let appEvaluate;
  for (let i = 0; !appEvaluate && i < 100; i++) { appEvaluate = await cdp.appContext(); if (!appEvaluate) await sleep(50); }
  assert(appEvaluate, 'single-file app initializes in opaque sandbox');
  assert.equal(await cdp.evaluate('window.nativeAutoExpanded'), true, 'native creation card auto-expands and mounts immediately');
  assert.deepEqual(mounts, [{ projectDir: '/fixture', chatId: 'chat', callId: 'native-create' }], 'native card binds by persisted call identity only');
  for (let i = 0; i < 100 && await appEvaluate("document.querySelector('#ready').textContent") !== 'initialized'; i++) await sleep(50);
  assert.equal(await appEvaluate("document.querySelector('#ready').textContent"), 'initialized');
  assert.equal(await appEvaluate("[document.documentElement,document.body].every(e=>getComputedStyle(e).backgroundColor==='rgba(0, 0, 0, 0)')"), true, 'app shell stays transparent');
  assert.equal(await cdp.evaluate("getComputedStyle(document.querySelector('.mcp-app iframe')).backgroundColor"), 'rgba(0, 0, 0, 0)', 'host frame stays transparent');
  async function assertBackdrop(rgb, label) {
    await cdp.evaluate("document.querySelector('.mcp-app iframe').scrollIntoView({block:'center'})");
    await sleep(100); // wait for cross-process frame compositing
    // A transcript card can leave transparent space below the auto-sized
    // author body. Sample inside its painted box, not that trailing space.
    const bodyBottom = await appEvaluate('document.body.getBoundingClientRect().bottom');
    const point = await cdp.evaluate(`(()=>{const r=document.querySelector('.mcp-app iframe').getBoundingClientRect();return [Math.floor(r.right-16),Math.floor(r.top+Math.min(r.height,${bodyBottom})-16)];})()`);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const pixel = await cdp.evaluate(`(async()=>{
      const bytes=Uint8Array.from(atob(${JSON.stringify(screenshot.data)}),c=>c.charCodeAt(0));
      const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);image.close();
      return Array.from(ctx.getImageData(${point[0]},${point[1]},1,1).data);
    })()`);
    assert.deepEqual(pixel, [...rgb, 255], label);
  }
  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
    for (const rgb of [[236, 240, 245], [24, 32, 42]]) {
      await cdp.evaluate(`document.body.style.backgroundColor='rgb(${rgb.join(',')})'`);
      await assertBackdrop(rgb, 'host backdrop visible through both sandbox layers at ' + width);
    }
  }
  await cdp.evaluate("document.documentElement.style.setProperty('--bg','rgb(50, 60, 70)');document.querySelector('.mcp-app__header button').click()");
  await sleep(100);
  await assertBackdrop([50, 60, 70], 'fullscreen shows its sheet backdrop, not underlying chat');
  await cdp.evaluate("document.querySelector('.mcp-app__header button').click()");
  await sleep(100);
  await appEvaluate("document.body.style.backgroundColor='rgb(70, 90, 110)'");
  await assertBackdrop([70, 90, 110], 'author-selected opaque app background is preserved');
  await appEvaluate("document.body.style.backgroundColor='transparent'");
  await appEvaluate("document.querySelector('#message').click()");
  for (let i = 0; !appMessages.length && i < 100; i++) await sleep(50);
  assert.deepEqual(appMessages, [{ role: 'user', content: [{ type: 'text', text: 'Single-file message' }] }]);
  await cdp.evaluate("window.sendAgentMessageToApp('Hello from agent')");
  for (let i = 0; i < 100 && await appEvaluate("document.querySelector('#incoming').textContent") !== 'Hello from agent'; i++) await sleep(50);
  assert.equal(await appEvaluate("document.querySelector('#incoming').textContent"), 'Hello from agent', 'agent pushes message to app via AppBridge sendToolResult');
  assert.equal(await cdp.evaluate("document.querySelector('#frame').lastElementChild === window.nativeCard"), true, 'MCP App card remains pinned at the bottom of the transcript after later tool calls and messages');
  currentLabel = 'reloaded-v2';
  await cdp.evaluate("window.updateNativeAppInPlace()");
  for (let i = 0; mounts.length < 2 && i < 100; i++) await sleep(50);
  assert.equal(mounts.length, 2, 'update reloads the existing mounted app card');
  assert.deepEqual(mounts[1], { projectDir: '/fixture', chatId: 'chat', callId: 'native-create' }, 'in-place update remounts the original card rather than spawning a second iframe');
  assert.equal(await cdp.evaluate("document.querySelectorAll('.mcp-app').length"), 1, 'only one MCP App frame stays mounted after an in-place update');
  assert.equal(await cdp.evaluate("document.querySelector('.mcp-app__title').textContent"), 'Single-file app v2', 'app header title updates when renamed');
  assert.equal(await cdp.evaluate("document.querySelector('#frame').lastElementChild === window.nativeCard"), true, 'updated MCP App card stays pinned at the bottom');
  appEvaluate = null;
  for (let i = 0; i < 100; i++) {
    appEvaluate = await cdp.appContext();
    if (appEvaluate && await appEvaluate("document.querySelector('#ready')?.textContent").catch(() => '') === 'reloaded-v2') break;
    await sleep(50);
  }
  assert.equal(await appEvaluate("document.querySelector('#ready').textContent"), 'reloaded-v2', 'updated app source renders in the existing card');
  assert.equal(await appEvaluate("fetch('" + base + "/api/settings').then(()=>false).catch(()=>true)"), true, 'no host API fetch');
  await cdp.evaluate('window.createSecondApp()');
  assert.equal(await cdp.evaluate("document.querySelector('#frame').lastElementChild === document.querySelector('[data-tool-id=\"second-create\"]')"), true, 'newest app card takes the bottom slot');
  assert.equal(await cdp.evaluate("[...document.querySelector('#frame').children].filter(c => c.dataset.mcpAppCard).length"), 1, 'only the latest app card stays pinned');
  assert.equal(await cdp.evaluate("[...document.querySelector('#frame').children].indexOf(window.nativeCard) < [...document.querySelector('#frame').children].findIndex(c => c.textContent.includes('App is ready below'))"), true, 'older app card is back in its chat position, before the messages that followed it');
  // Every app keeps running, wherever its card sits.
  const frameChildren = "[...document.querySelector('#frame').children]";
  const pinnedIds = "[...document.querySelector('#frame').children].filter(c => c.dataset.mcpAppCard).map(c => c.dataset.toolId)";
  const framesSettled = async (count, label) => {
    let state;
    for (let i = 0; i < 200; i++) {
      state = await cdp.evaluate("({ frames: document.querySelectorAll('#frame .mcp-app iframe').length, busy: document.querySelectorAll('#frame .mcp-app [role=status]').length, retry: document.querySelectorAll('#frame .mcp-app__btn--retry').length })");
      if (state.frames === count && state.busy === 0 && state.retry === 0) return;
      await sleep(50);
    }
    assert.fail(label + ': ' + JSON.stringify(state));
  };
  await framesSettled(2, 'both apps run after the older one went back to the chat');
  assert.equal(mounts.length, 3, 'moving the older card keeps its running view, with no new mount');
  assert.equal(await appEvaluate("document.querySelector('#ready').textContent"), 'reloaded-v2', 'older app is the same running view');
  const messagesBefore = appMessages.length;
  await appEvaluate("document.querySelector('#message').click()");
  for (let i = 0; appMessages.length === messagesBefore && i < 100; i++) await sleep(50);
  assert.equal(appMessages.length, messagesBefore + 1, 'older app can still talk to the host from its chat position');
  // A server app follows the same rule: the latest expanded one takes the bottom.
  await cdp.evaluate("window.addServerAppTool('server-older'); window.addServerAppTool('server-newer')");
  await cdp.evaluate("document.querySelector('[data-tool-id=\"server-newer\"] .tool-card__head').click()");
  await framesSettled(3, 'server app runs');
  assert.deepEqual(await cdp.evaluate(pinnedIds), ['server-newer'], 'a server app takes the bottom from an on-the-fly app');
  assert.equal(await cdp.evaluate("document.querySelector('#frame').lastElementChild.dataset.toolId"), 'server-newer', 'latest server app sits at the bottom');
  assert.equal(await cdp.evaluate(frameChildren + ".findIndex(c => c.dataset.toolId === 'second-create') < " + frameChildren + ".findIndex(c => c.textContent.includes('Second app is ready'))"), true, 'the app it replaced is back in chat order');
  await cdp.evaluate("document.querySelector('[data-tool-id=\"server-older\"] .tool-card__head').click()");
  await framesSettled(4, 'older server app runs too');
  assert.deepEqual(await cdp.evaluate(pinnedIds), ['server-newer'], 'opening an older app does not take the bottom from a newer one');
  assert.equal(await cdp.evaluate(frameChildren + ".findIndex(c => c.dataset.toolId === 'server-older') < " + frameChildren + ".findIndex(c => c.textContent.includes('After server-older'))"), true, 'the older app runs from its chat position');
  assert.equal(await cdp.evaluate("getComputedStyle(document.querySelector('[data-tool-id=\"second-create\"]')).contentVisibility"), 'visible', 'an app in chat order is never skipped as an off-screen row');
  // Browsers without moveBefore reload a moved iframe; its ticket is spent, so
  // the view takes a fresh mount rather than staying blank.
  const mountsBefore = mounts.length;
  await cdp.evaluate("window.savedMoveBefore = Element.prototype.moveBefore; delete Element.prototype.moveBefore; window.addServerAppTool('server-latest')");
  await cdp.evaluate("document.querySelector('[data-tool-id=\"server-latest\"] .tool-card__head').click()");
  for (let i = 0; mounts.length < mountsBefore + 2 && i < 200; i++) await sleep(50);
  assert.equal(mounts.length, mountsBefore + 2, 'a reloaded view takes a fresh mount');
  assert.equal(mounts.at(-1).callId, 'server-newer', 'the fresh mount is for the moved card');
  await framesSettled(5, 'a reloaded view runs again');
  await cdp.evaluate("Element.prototype.moveBefore = window.savedMoveBefore");
  assert.deepEqual(await cdp.evaluate(pinnedIds), ['server-latest'], 'latest app holds the bottom');
  // History: the newest app wins however its page was painted.
  const orderOf = host => "[...document.querySelector('#" + host + "').children].map(c => c.dataset.toolId || c.textContent.trim().split('\\n')[0])";
  const indexIn = (order, needle) => order.findIndex(entry => String(entry).includes(needle));
  await cdp.evaluate('window.prependTwoApps()');
  let order = await cdp.evaluate(orderOf('prepend'));
  assert.equal(order.at(-1), 'page-b', 'newest app of an older page takes the bottom, not the first: ' + JSON.stringify(order));
  assert.deepEqual(await cdp.evaluate("[...document.querySelectorAll('#prepend > [data-mcp-app-card]')].map(c => c.dataset.toolId)"), ['page-b'], 'only one app of the page is pinned');
  assert(indexIn(order, 'page-older') < indexIn(order, 'page-a') && indexIn(order, 'page-a') < indexIn(order, 'Tail row'), 'older apps stay in chat order: ' + JSON.stringify(order));
  await cdp.evaluate('window.createOnPrependPage()');
  order = await cdp.evaluate(orderOf('prepend'));
  assert.equal(order.at(-1), 'page-live', 'a live app takes the bottom');
  assert(indexIn(order, 'page-b') < indexIn(order, 'Tail row') && indexIn(order, 'page-a') < indexIn(order, 'page-b'), 'the app it replaced returns to its chat slot: ' + JSON.stringify(order));
  await cdp.evaluate('window.prependFirstRowApp()');
  order = await cdp.evaluate(orderOf('first-row'));
  assert(indexIn(order, 'older') < indexIn(order, 'first-a') && indexIn(order, 'first-a') < indexIn(order, 'Tail row'), 'an app that opened its page returns below older rows: ' + JSON.stringify(order));
  await cdp.evaluate('window.renderLongChat()');
  for (let i = 0; i < 100 && await cdp.evaluate("document.querySelector('#backfill').children.length") < 68; i++) await sleep(50);
  order = await cdp.evaluate(orderOf('backfill'));
  assert.equal(order.at(-1), 'fill-b', 'latest app of a long chat takes the bottom: ' + JSON.stringify(order));
  assert(indexIn(order, 'Row 1004') < indexIn(order, 'fill-a') && indexIn(order, 'fill-a') < indexIn(order, 'Row 1100') && indexIn(order, 'Row 1100') < indexIn(order, 'Row 2000'), 'backfilled rows stay in order around the pinned app: ' + JSON.stringify(order));
  await cdp.evaluate("const upload=document.querySelector('#instant-mcp-app-file');const data=new DataTransfer();data.items.add(new File(['document.body.textContent=\"Uploaded\";'],'upload.js'));upload.files=data.files;upload.dispatchEvent(new Event('change',{bubbles:true}));");
  await sleep(50);
  await cdp.evaluate("document.querySelector('.instant-mcp-app button').click()");
  for (let i = 0; imports.length < 2 && i < 100; i++) await sleep(50);
  assert.deepEqual(imports[1], { projectDir: '/fixture', name: 'On-the-fly app', filename: 'upload.js', source: 'document.body.textContent="Uploaded";' });
  await cdp.evaluate("{const mode=document.querySelector('#instant-mcp-app-mode');mode.value='request';mode.dispatchEvent(new Event('change',{bubbles:true}));}");
  await sleep(50);
  await cdp.evaluate("{const input=document.querySelector('#instant-mcp-app-request');input.value='A checklist';input.dispatchEvent(new Event('input',{bubbles:true}));}");
  await sleep(50);
  await cdp.evaluate("document.querySelector('.instant-mcp-app button').click()");
  for (let i = 0; !requests.length && i < 100; i++) await sleep(50);
  assert.deepEqual(requests, [{ projectDir: '/fixture', name: 'On-the-fly app', request: 'A checklist' }]);
  for (let i = 0; await cdp.evaluate('location.hash') !== '#/chat/devchat' && i < 100; i++) await sleep(50);
  assert.equal(await cdp.evaluate('location.hash'), '#/chat/devchat', 'request opens separate development chat');
  console.log('PASS single-file SDK sandbox initialization/messaging, transparent light/dark/mobile pixels, fullscreen/author backgrounds, path/upload/request forms, chat navigation and 44px targets');
} finally {
  cdp?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill();
    await Promise.race([exited, sleep(3000)]);
  }
  await sleep(300);
  await sandbox.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
