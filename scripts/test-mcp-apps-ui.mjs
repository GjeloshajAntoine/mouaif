import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const { findChrome } = require('./lib/capture-fixture.js');
import { connectAppCdp } from './lib/mcp-apps-cdp.mjs';
const { createSandboxService, buildPolicy } = require('../src/mcp-apps-sandbox.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-apps-browser-'));
const sandbox = createSandboxService({ host: '127.0.0.1' });
const appBundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'js', contents: `
  import { App } from '@modelcontextprotocol/ext-apps';
  const app = new App({ name: 'Official SDK fixture', version: '1' }, { availableDisplayModes: ['inline', 'fullscreen'] });
  window.order = [];
  app.ontoolinput = p => { order.push('input'); document.querySelector('#input').textContent = JSON.stringify(p.arguments); };
  app.ontoolresult = p => { order.push('result'); document.querySelector('#result').textContent = p.content[0].text; };
  app.onteardown = async () => { document.querySelector('#result').textContent = 'torn down'; return {}; };
  app.connect().then(() => { document.querySelector('#ready').textContent = 'initialized'; });
  document.querySelector('#call').onclick = async () => {
    try { const result = await app.callServerTool({ name: 'edit', arguments: {} }); document.querySelector('#result').textContent = result.content[0].text; }
    catch(e) { document.querySelector('#result').textContent = e.message; }
  };
  document.querySelector('#escape').onclick = () => { try { document.querySelector('#security').textContent = parent.parent.document.cookie; } catch(e) { document.querySelector('#security').textContent = 'isolated'; } };
  document.querySelector('#message').onclick = async () => {
    try { await app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Explain this chart' }] }); document.querySelector('#security').textContent = 'message accepted'; }
    catch(e) { document.querySelector('#security').textContent = e.message; }
  };
  document.querySelector('#context').onclick = async () => { try { await app.updateModelContext({ content: [{ type: 'text', text: 'unapproved' }] }); } catch(e) { document.querySelector('#security').textContent = 'unsupported'; } };
` }, bundle: true, write: false, format: 'iife' });
const html = '<!doctype html><meta name="viewport" content="width=device-width"><p id="ready"></p><p id="input"></p><p id="result"></p><p id="security"></p><button id="call">Call tool</button><button id="escape">Escape</button><button id="context">Context</button><button id="message">Message</button><script>' + appBundle.outputFiles[0].text + '</script>';
const hostBundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
  import { h, render } from 'preact';
  import { McpAppFrame } from './frontend/src/components/chat/McpAppFrame.jsx';
  window.mount = () => render(h(McpAppFrame, { projectDir: '/fixture', chatId: 'abcd1234', callId: 'fixture', onAuthorize: async request => { window.approval = request; return window.deny ? 'deny' : 'allow-once'; } }), document.querySelector('#app'));
  window.unmount = () => render(null, document.querySelector('#app'));
  window.mount();
` }, bundle: true, write: false, outdir: '/tmp/apps-ui', format: 'esm' });
const js = hostBundle.outputFiles.find(f => f.path.endsWith('.js')).text;
const css = hostBundle.outputFiles.find(f => f.path.endsWith('.css')).text;
let ticket, base, mountCount = 0, callCount = 0, deleted = 0;
const appMessages = [];
const approved = new Set();
const server = http.createServer(async (req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url?.startsWith('/api/mcp/apps/sandbox/')) {
    return (server._samePortSandbox || sandbox).handleProxy(req, res, req.url.slice('/api/mcp/apps/sandbox/'.length));
  }
  if (req.url === '/api/mcp/apps/mount') {
    mountCount++;
    if (mountCount === 2) {
      const samePortSandbox = createSandboxService({ samePort: true });
      ticket = await samePortSandbox.issue(base, buildPolicy({}, base));
      server._samePortSandbox = samePortSandbox;
      return json(200, { enabled: true, id: 'fixture', title: 'SDK fixture', html, url: ticket.url, origin: ticket.origin, csp: {}, arguments: { value: 7 }, result: { content: [{ type: 'text', text: 'original result' }] } });
    }
    ticket = await sandbox.issue(base, buildPolicy({}, base));
    return json(200, { enabled: true, id: 'fixture', title: 'SDK fixture', html, url: ticket.url, origin: ticket.origin, csp: {}, arguments: { value: 7 }, result: { content: [{ type: 'text', text: 'original result' }] } });
  }
  if (req.url === '/api/mcp/apps/fixture/call') {
    const data = JSON.parse(body);
    if (!approved.has(data.requestId)) { approved.add(data.requestId); return json(409, { code: 'EAUTH_REQUIRED', request: { callId: 'server-owned', summary: 'SDK fixture approval' } }); }
    callCount++; return json(200, { content: [{ type: 'text', text: 'approved tool result' }] });
  }
  if (req.url === '/api/mcp/apps/fixture/message') { appMessages.push(JSON.parse(body)); return json(200, {}); }
  if (req.url === '/api/mcp/apps/fixture/status') return json(200, { ok: true });
  if (req.method === 'DELETE') { deleted++; return json(200, { ok: true }); }
  if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(js); return; }
  if (req.url === '/app.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(css); return; }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' http://127.0.0.1:*" });
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="app"></div><p id="fallback">text fallback remains</p><script type="module" src="/app.js"></script>');
});
let chrome, cdp;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  const chromePath = findChrome();
  assert(chromePath, 'Chrome is required');
  chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + temp, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; !fs.existsSync(path.join(temp, 'DevToolsActivePort')) && i < 100; i++) await sleep(50);
  const port = fs.readFileSync(path.join(temp, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  cdp = await connectAppCdp(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  const evaluate = async expression => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await cdp.send('Page.navigate', { url: base });
  for (let i = 0; i < 100; i++) { if (await evaluate("!!document.querySelector('.mcp-app iframe') && !document.querySelector('.mcp-app [role=status]')")) break; await sleep(100); }
  assert.equal(await evaluate("document.querySelector('.mcp-app [role=status]')?.textContent || ''"), '', 'official App SDK initializes');
  assert.equal(mountCount, 1, 'one mount, no handshake render loop');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, '360 px has no horizontal overflow');
  assert.equal(await evaluate("document.querySelector('.mcp-app button').getBoundingClientRect().height >= 44"), true);
  await evaluate("document.querySelector('.mcp-app button').click()");
  assert.equal(await evaluate("!!document.querySelector('.mcp-app--fullscreen')"), true);
  await evaluate("document.querySelector('.mcp-app button').click()");
  assert.equal(await evaluate("!!document.querySelector('.mcp-app--fullscreen')"), false);
  // Evaluate inside the actual opaque-origin app, not through parent DOM access.
  await cdp.attachFrames();
  let appEvaluate;
  for (let i = 0; !appEvaluate && i < 100; i++) { appEvaluate = await cdp.appContext(); if (!appEvaluate) await sleep(50); }
  assert(appEvaluate, 'opaque view found through normal site-isolated child sessions');
  assert.equal(await appEvaluate("document.querySelector('#result').textContent"), 'original result');
  await appEvaluate("document.querySelector('#escape').click()");
  assert.equal(await appEvaluate("document.querySelector('#security').textContent"), 'isolated');
  assert.equal(await appEvaluate("fetch('" + base + "/api/settings').then(()=>false).catch(()=>true)"), true, 'header CSP blocks host API connection');
  await appEvaluate("document.querySelector('#call').click()");
  for (let i = 0; callCount === 0 && i < 100; i++) await sleep(50);
  assert.equal(callCount, 1, 'App SDK tools/call resumes after approval');
  assert.equal(await evaluate('window.approval.callId'), 'server-owned');
  await evaluate('window.deny=true');
  await appEvaluate("document.querySelector('#call').click()");
  await sleep(200);
  assert.equal(callCount, 1, 'denied call never executes');
  await appEvaluate("document.querySelector('#context').click()");
  await sleep(100);
  assert.equal(await appEvaluate("document.querySelector('#security').textContent"), 'unsupported', 'unadvertised context mutation rejected');
  await appEvaluate("document.querySelector('#message').click()");
  for (let i = 0; appMessages.length === 0 && i < 100; i++) await sleep(20);
  assert.deepEqual(appMessages, [{ role: 'user', content: [{ type: 'text', text: 'Explain this chart' }] }], 'official SDK ui/message reaches host without approval');
  for (let i = 0; i < 100 && await appEvaluate("document.querySelector('#security').textContent") !== 'message accepted'; i++) await sleep(20);
  assert.equal(await appEvaluate("document.querySelector('#security').textContent"), 'message accepted');
  // Wrong-source messages cannot resize or initialize the app.
  await evaluate("window.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:9999}},location.origin)");
  assert.equal(await evaluate("parseInt(document.querySelector('.mcp-app iframe').style.height) <= innerHeight * .7"), true);
  await evaluate("document.querySelectorAll('.mcp-app button')[1].click()");
  for (let i = 0; i < 100 && await evaluate("document.querySelector('.mcp-app button')?.textContent") !== 'Retry'; i++) await sleep(20);
  await evaluate("document.querySelector('.mcp-app button').click()");
  for (let i = 0; i < 100; i++) { if (await evaluate("!!document.querySelector('.mcp-app iframe') && !document.querySelector('.mcp-app [role=status]')")) break; await sleep(100); }
  assert.equal(await evaluate("document.querySelector('.mcp-app [role=status]')?.textContent || ''"), '', 'HTTPS CSP-sandboxed proxy initializes official App SDK');
  await evaluate('window.unmount()');
  for (let i = 0; deleted < 2 && i < 100; i++) await sleep(20);
  assert.equal(deleted, 2, 'unmount revokes mount');
  assert.equal(await evaluate("document.querySelector('#fallback').textContent"), 'text fallback remains');
  console.log('PASS official App SDK initialization, mobile/fullscreen, origin isolation, header CSP, approval/denial, unsupported context and lifecycle');
} finally {
  cdp?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    await Promise.race([exited, sleep(3000)]);
  }
  await sleep(300);
  await sandbox.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
