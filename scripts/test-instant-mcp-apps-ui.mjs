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
const sandbox = createSandboxService({ host: '127.0.0.1' });
const html = renderHtml(`
  document.querySelector('#app').innerHTML = '<p id="ready">waiting</p><button id="message">Send text</button>';
  window.mouaifAppReady.then(() => document.querySelector('#ready').textContent = 'initialized');
  document.querySelector('#message').onclick = async () => {
    await window.mouaifApp.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Single-file message' }] });
    document.querySelector('#ready').textContent = 'accepted';
  };
`, 'js', 'Single-file app');
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
  import { h, render } from 'preact';
  import { InstantMcpApp } from './frontend/src/components/settings/InstantMcpApp.jsx';
  import { McpAppFrame } from './frontend/src/components/chat/McpAppFrame.jsx';
  render(h(InstantMcpApp, { projectDir: '/fixture', onImported: () => window.imported = true }), document.querySelector('#form'));
  render(h(McpAppFrame, { projectDir: '/fixture', chatId: 'chat', callId: 'call' }), document.querySelector('#frame'));
` }, bundle: true, write: false, outdir: '/tmp/instant-ui', format: 'esm' });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
let base, chrome, cdp;
const imports = [], requests = [], appMessages = [];
const server = http.createServer(async (req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/api/mcp/apps/import') {
    imports.push(JSON.parse(raw)); return json(201, { server: { id: 'one' }, path: 'counter.js' });
  }
  if (req.url === '/api/mcp/apps/request') {
    requests.push(JSON.parse(raw)); return json(201, { chatId: 'devchat', path: '.mouaif/mcp-apps/unique.html' });
  }
  if (req.url === '/api/mcp/apps/mount') {
    const ticket = await sandbox.issue(base, buildPolicy({}, base));
    return json(200, { enabled: true, id: 'fixture', title: 'Single-file app', html, ...ticket, csp: {},
      arguments: {}, result: { content: [{ type: 'text', text: 'ready' }] } });
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
  assert.equal(await cdp.evaluate('window.imported'), true);
  let appEvaluate;
  for (let i = 0; !appEvaluate && i < 100; i++) { appEvaluate = await cdp.appContext(); if (!appEvaluate) await sleep(50); }
  assert(appEvaluate, 'single-file app initializes in opaque sandbox');
  for (let i = 0; i < 100 && await appEvaluate("document.querySelector('#ready').textContent") !== 'initialized'; i++) await sleep(50);
  assert.equal(await appEvaluate("document.querySelector('#ready').textContent"), 'initialized');
  await appEvaluate("document.querySelector('#message').click()");
  for (let i = 0; !appMessages.length && i < 100; i++) await sleep(50);
  assert.deepEqual(appMessages, [{ role: 'user', content: [{ type: 'text', text: 'Single-file message' }] }]);
  assert.equal(await appEvaluate("fetch('" + base + "/api/settings').then(()=>false).catch(()=>true)"), true, 'no host API fetch');
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
  console.log('PASS single-file SDK sandbox initialization/messaging, path/upload/request forms, chat navigation, mobile widths and 44px targets');
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
