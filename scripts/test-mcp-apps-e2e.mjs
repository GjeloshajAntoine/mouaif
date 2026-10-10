// Official App SDK + real REST/MCP/AI runner, with normal Chrome isolation.
// All storage, ports and provider traffic are test-local; no running app restart.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-apps-e2e-'));
process.env.MOUAIF_HOME = path.join(temp, 'home');
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const mcp = require('../src/mcp.js');
const authz = require('../src/tools/authorization.js');
const { runningChats, runningKey } = require('../src/server-shared.js');
const { createServer } = require('../src/index.js');
const { findChrome } = require('./lib/capture-fixture.js');
const projectDir = path.join(temp, 'project'); fs.mkdirSync(projectDir);
const app = createServer(0);
let modelTool, requests = 0, providerResult, release;
const provider = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = (value, finish_reason = null) => res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason }] }) + '\n\n');
  if (requests === 1) {
    assert(body.tools.some(t => t.function.name === modelTool), 'ordinary MCP model tool advertised');
    delta({ tool_calls: [{ index: 0, id: 'provider_call', type: 'function', function: { name: modelTool, arguments: '{}' } }] }, 'tool_calls');
    res.end('data: [DONE]\n\n');
  } else {
    providerResult = body.messages.find(row => row.role === 'tool' && row.tool_call_id === 'provider_call');
    delta({ content: 'Actual streamed ' });
    release = () => { if (!res.writableEnded) { delta({ content: 'reply' }, 'stop'); res.end('data: [DONE]\n\n'); } };
    req.socket.once('close', () => { release = null; });
  }
});
let base, chat, server, bundle, styles, chrome, cdp;
// The fixture shell alone is custom. All API routes and browser authorization
// are proxied to createServer, preserving Origin/Host/cookies unchanged.
const front = http.createServer((req, res) => {
  if (req.url === '/fixture.js' || req.url === '/fixture.css') {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.js') ? 'application/javascript' : 'text/css' });
    return res.end(req.url.endsWith('.js') ? bundle : styles);
  }
  const upstream = http.request({ hostname: '127.0.0.1', port: app.address().port, path: req.url, method: req.method, headers: req.headers }, response => {
    if (req.url === '/') {
      response.resume();
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': response.headers['set-cookie'],
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:*" });
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><textarea id="draft">unsent composer draft</textarea><div id="app"></div><div id="transcript"></div><p id="live"></p><button id="stop">Stop</button><script type="module" src="/fixture.js"></script>');
    } else { res.writeHead(response.statusCode, response.headers); response.pipe(res); }
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
  res.on('close', () => upstream.destroy());
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await sleep(40); }
  throw new Error('Timed out: ' + label + (chat ? '\n' + JSON.stringify({ pending: authz.listPending(projectDir, chat.id), rows: messages.listMessages(projectDir, chat.id), requests }) : ''));
}
try {
  const appCode = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { App } from '@modelcontextprotocol/ext-apps';
    const app = new App({ name: 'Real host fixture', version: '1' }, {});
    window.received = []; window.addEventListener('message', e => received.push(e.data));
    app.ontoolresult = () => document.querySelector('#ready').textContent = 'ready';
    app.onteardown = async () => ({});
    app.connect();
    document.querySelector('#message').onclick = async () => {
      try { window.ack = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Explain this chart' }] }); document.querySelector('#ack').textContent = 'accepted'; }
      catch(e) { document.querySelector('#ack').textContent = e.message; }
    };
    document.querySelector('#call').onclick = async () => {
      try { await app.callServerTool({ name: 'edit', arguments: {} }); } catch(e) { document.querySelector('#ack').textContent = e.message; }
    };
  ` }, bundle: true, write: false, format: 'iife' });
  const htmlFile = path.join(temp, 'app.html');
  fs.writeFileSync(htmlFile, '<!doctype html><p id="ready"></p><p id="ack"></p><button id="message">Message</button><button id="call">App tool</button><script>' + appCode.outputFiles[0].text + '</script>');
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  settings.setApp({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + provider.address().port }] });
  settings.setProject(projectDir, { mcpApps: { enabled: true }, models: [{ id: 'fixture-model', provider: 'openai-compatible' }] });
  chat = chats.createChat(projectDir, { title: 'Real host Apps' });
  chats.updateChat(projectDir, chat.id, { draft: 'unsent composer draft', providerId: 'openai-compatible', modelId: 'fixture-model' });
  server = mcp.addServer(projectDir, { name: 'Real host app', command: process.execPath, args: [path.join(process.cwd(), 'scripts/test-mcp-apps-server.js'), htmlFile] });
  await mcp.startServer(projectDir, server.id);
  const name = mcp.composedToolName(server.slug, 'view'); modelTool = mcp.composedToolName(server.slug, 'model');
  messages.appendMessage(projectDir, chat.id, { role: 'tool', phase: 'call', toolCallId: 'view_call', name, args: {}, content: '{}' });
  messages.appendMessage(projectDir, chat.id, { role: 'tool', phase: 'result', toolCallId: 'view_call', name, ok: true, content: JSON.stringify({ content: [{ type: 'text', text: 'fallback' }] }) });
  const hostCode = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
    import { h, render } from 'preact';
    import { McpAppFrame } from './frontend/src/components/chat/McpAppFrame.jsx';
    import { authorizationCard } from './frontend/src/components/chat/cards.js';
    const projectDir = ${JSON.stringify(projectDir)}, chatId = ${JSON.stringify(chat.id)};
    const refs = { transcript: { current: document.querySelector('#transcript') }, pinnedToBottom: { current: false }, pendingCount: { current: 0 }, jump: { current: null } };
    window.mount = () => render(h(McpAppFrame, { projectDir, chatId, callId: 'view_call',
      onAuthorize: (request, signal) => authorizationCard({ ...request, signal }, projectDir, chatId, refs) }), document.querySelector('#app'));
    window.mount();
    document.querySelector('#stop').onclick = () => fetch('/api/tools/authorization/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir, chatId }) });
    window.follow = () => {
      window.live = new EventSource('/api/chats/' + chatId + '/live?projectDir=' + encodeURIComponent(projectDir));
      live.addEventListener('message', e => { const data = JSON.parse(e.data); document.querySelector('#live').textContent += data.delta || ''; });
      live.addEventListener('live_segment', e => { document.querySelector('#live').textContent = JSON.parse(e.data).text; });
      live.addEventListener('run_end', () => live.close());
    };
  ` }, bundle: true, write: false, outdir: '/tmp/mcp-apps-e2e', format: 'esm' });
  bundle = hostCode.outputFiles.find(f => f.path.endsWith('.js')).text;
  styles = hostCode.outputFiles.find(f => f.path.endsWith('.css')).text;
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + front.address().port;
  chrome = spawn(findChrome(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + path.join(temp, 'chrome'), 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(temp, 'chrome', 'DevToolsActivePort');
  await until(() => fs.existsSync(portFile), 'Chrome startup');
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  cdp = await connectAppCdp(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.navigate', { url: base });
  const evaluate = expression => cdp.evaluate(expression);
  await until(async () => await evaluate("!!document.querySelector('.mcp-app iframe') && !document.querySelector('.mcp-app [role=status]')"), 'SDK initialization');
  await cdp.attachFrames();
  let appEvaluate; await until(async () => (appEvaluate = await cdp.appContext()), 'site-isolated App context');
  assert.equal(await appEvaluate("fetch('" + base + "/api/settings').then(()=>false).catch(()=>true)"), true);
  await appEvaluate("document.querySelector('#message').click()");
  await until(() => authz.listPending(projectDir, chat.id).some(r => r.tool === modelTool), 'normal AI tool approval');
  await until(async () => await appEvaluate("document.querySelector('#ack').textContent === 'accepted'"), 'message acknowledgement');
  assert.deepEqual(await appEvaluate('window.ack'), {});
  const user = messages.listMessages(projectDir, chat.id).find(r => r.role === 'user');
  assert.match(user.content, /^\[MCP App: Real host app — view\]\nExplain this chart$/);
  const pending = authz.listPending(projectDir, chat.id).find(r => r.tool === modelTool);
  const response = await fetch(base + '/api/tools/authorization/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir, chatId: chat.id, callId: pending.callId, decision: 'allow-once' }) });
  assert.equal(response.status, 200);
  await until(() => release && providerResult, 'authorized model tool and next provider round');
  assert.match(providerResult.content, /text fallback/);
  await evaluate('window.follow()');
  await until(async () => await evaluate("document.querySelector('#live').textContent.includes('Actual streamed')"), 'actual SSE reply');
  assert.equal(await evaluate("document.querySelector('#draft').value"), 'unsent composer draft');
  assert.equal(chats.getChat(projectDir, chat.id).draft, 'unsent composer draft');
  // Accepted AI run continues while Close revokes only the app capability.
  await evaluate("[...document.querySelectorAll('.mcp-app button')].find(b=>b.textContent==='Close').click()");
  await until(async () => await evaluate("!!document.querySelector('.mcp-app [role=status]') && !document.querySelector('.mcp-app iframe')"), 'explicit Close');
  assert(runningChats.has(runningKey(projectDir, chat.id)));
  release();
  await until(() => !runningChats.has(runningKey(projectDir, chat.id)), 'completed AI run');
  assert(messages.listMessages(projectDir, chat.id).some(r => r.role === 'assistant' && r.content === 'Actual streamed reply'));
  await evaluate("document.querySelector('.mcp-app button').click()");
  await until(async () => await evaluate("!!document.querySelector('.mcp-app iframe') && !document.querySelector('.mcp-app [role=status]')"), 'Retry');
  await until(async () => (appEvaluate = await cdp.appContext()), 'retried App context');
  await appEvaluate("document.querySelector('#call').click()");
  await until(async () => await evaluate("!!document.querySelector('.tool-card--authorization')"), 'app approval UI');
  await evaluate("[...document.querySelectorAll('.mcp-app button')].find(b=>b.textContent==='Close').click()");
  await until(async () => !(await evaluate("!!document.querySelector('.tool-card--authorization')")) && authz.listPending(projectDir, chat.id).length === 0, 'abandoned approval removed');
  // New automatic turn exercises the normal host Stop endpoint.
  await sleep(5100);
  await evaluate("document.querySelector('.mcp-app button').click()");
  await until(async () => await evaluate("!!document.querySelector('.mcp-app iframe') && !document.querySelector('.mcp-app [role=status]')"), 'second Retry');
  await until(async () => (appEvaluate = await cdp.appContext()), 'second App context');
  await appEvaluate("document.querySelector('#message').click()");
  await until(() => runningChats.has(runningKey(projectDir, chat.id)), 'second automatic turn');
  await until(async () => await appEvaluate("document.querySelector('#ack').textContent === 'accepted'"), 'second acknowledgement');
  const received = JSON.stringify(await appEvaluate('window.received'));
  assert.equal(received.includes('Actual streamed'), false, 'AI response is never returned to App');
  assert.equal(received.includes('mouaif_session'), false, 'cookie never enters bridge');
  await evaluate("document.querySelector('#stop').click()");
  await until(() => !runningChats.has(runningKey(projectDir, chat.id)), 'normal Stop cancels automatic turn');
  // A hidden/restored tab cannot keep silently usable app capabilities.
  await evaluate("Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'))");
  await until(async () => !(await evaluate("!!document.querySelector('.mcp-app iframe')")), 'tab-hide teardown');
  await evaluate("Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'))");
  assert.equal(await evaluate("document.querySelector('.mcp-app button').textContent"), 'Retry');
  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, width + ' px no overflow');
    assert.equal(await evaluate("[...document.querySelectorAll('.mcp-app button')].every(b=>b.getBoundingClientRect().height>=44)"), true);
  }
  console.log('PASS MCP Apps real-host SDK → persisted prompt → approved MCP tool → actual SSE reply, Close/Retry/approval cleanup, Stop, draft preservation and 360/390/430 px');
} finally {
  cdp?.close();
  if (chrome && chrome.exitCode === null) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await Promise.race([exited, sleep(3000)]); }
  release?.();
  await mcp.stopAll();
  for (const httpServer of [front, provider, app]) { httpServer.closeAllConnections(); if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve)); }
  settings.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
