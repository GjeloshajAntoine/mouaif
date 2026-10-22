// Browser coverage for the long-running agent's on-the-fly MCP App panel.
//
// The panel is a single-file HTML app mounted by the PRODUCTION host: the
// real InstantMcpApp component, the real MCP Apps sandbox, and the real
// AppBridge. The app source is the tracked file under
// scripts/long-running-agent-mockup/, so what is checked here is the file
// that ships, not a copy.
//
// What this checks:
//   * the app mounts in the sandbox and boots against the real bridge;
//   * an agent push (create_mcp_app with `message`) fills the panel in;
//   * the panel's buttons send real ui/message payloads to the host;
//   * the panel fits a 360 px phone with 44 px touch targets.
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

const APP_FILE = path.join('scripts', 'long-running-agent-mockup', 'agent-panel.html');
const appSource = fs.readFileSync(path.join(process.cwd(), APP_FILE), 'utf8');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-agent-panel-'));
const sandbox = createSandboxService({ host: '127.0.0.1' });
const makeHtml = () => renderHtml(appSource, 'html', 'Agent run control');

const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
  import { h, render } from 'preact';
  import { InstantMcpApp } from './frontend/src/components/settings/InstantMcpApp.jsx';
  import { appendMessageToTranscript, appendToolCallCard, appendToolResultCard } from './frontend/src/components/chat/transcript.js';
  render(h(InstantMcpApp, { projectDir: '/fixture', onImported: () => window.imported = true }), document.querySelector('#form'));
  const root = document.querySelector('#frame');
  const refs = { transcript: { current: root }, pinnedToBottom: { current: false }, pendingCount: { current: 0 },
    jumpBtn: { current: null }, usageSummary: { current: null }, _suspendScrollPin: true,
    mcpAppContext: { projectDir: '/fixture', chatId: 'chat' } };
  // The agent pushes a run state into the mounted app.
  window.pushState = text => {
    appendToolCallCard({ id: 'agent-msg', name: 'create_mcp_app', args: { name: 'Agent run control', message: text } }, refs);
    appendToolResultCard({ id: 'agent-msg', name: 'create_mcp_app', ok: true,
      result: { ok: true, mode: 'message', name: 'Agent run control', message: text, content: [{ type: 'text', text }] } }, refs);
  };
  appendToolCallCard({ id: 'native-create', name: 'create_mcp_app', args: { name: 'Agent run control', path: 'agent-panel.html' } }, refs);
  appendToolResultCard({ id: 'native-create', name: 'create_mcp_app', ok: true,
    result: { ok: true, name: 'Agent run control', path: 'agent-panel.html', content: [{ type: 'text', text: 'ready' }] } }, refs);
` }, bundle: true, write: false, outdir: '/tmp/agent-panel-ui', format: 'esm' });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;

let base, chrome, cdp;
const appMessages = [];
const server = http.createServer(async (req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/api/mcp/apps/mount') {
    const ticket = await sandbox.issue(base, buildPolicy({}, base));
    return json(200, { enabled: true, id: 'fixture', title: 'Agent run control', html: makeHtml(), ...ticket, csp: {},
      arguments: {}, result: { path: 'agent-panel.html', content: [{ type: 'text', text: 'ready' }] } });
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
  for (let i = 0; i < 100 && !await cdp.evaluate("!!document.querySelector('.mcp-app iframe')"); i++) await sleep(50);

  let appEvaluate;
  // The panel has no #ready anchor, so find the sandbox frame by its own
  // markup instead of the shared helper's probe element.
  for (let i = 0; i < 100 && !appEvaluate; i++) {
    appEvaluate = await cdp.appContextBySelector('.panel');
    if (!appEvaluate) await sleep(50);
  }
  assert(appEvaluate, 'the agent panel mounts in the sandbox');
  assert.equal(await appEvaluate("!!document.querySelector('.panel')"), true, 'the panel renders');

  // The panel links to the host and asks for the current run state.
  for (let i = 0; i < 100 && await appEvaluate("document.querySelector('#link').dataset.connected") !== '1'; i++) await sleep(50);
  assert.equal(await appEvaluate("document.querySelector('#link').dataset.connected"), '1', 'the panel links to the chat bridge');
  for (let i = 0; !appMessages.length && i < 100; i++) await sleep(50);
  assert.equal(appMessages.length, 1, 'the panel asks the agent for the run state on boot');
  assert.match(appMessages[0].content[0].text, /run state/i, 'the boot request asks for the run state');

  // An agent push fills the panel in.
  const state = JSON.stringify({ state: { name: 'Long-running refactor', goal: 'Split the chat renderer.', state: 'running',
    step: 3, total: 6, turns: 11, budget: 40, cost: 0.047, elapsed: 72,
    steps: [{ title: 'Map the modules' }, { title: 'Read the code' }, { title: 'Rewrite' }, { title: 'Test' }] } });
  await cdp.evaluate('window.pushState(' + JSON.stringify(state) + ')');
  for (let i = 0; i < 100 && await appEvaluate("document.querySelector('#name').textContent") !== 'Long-running refactor'; i++) await sleep(50);
  assert.equal(await appEvaluate("document.querySelector('#name').textContent"), 'Long-running refactor', 'the pushed state fills the panel');
  assert.equal(await appEvaluate("document.querySelector('#pill').textContent"), 'running', 'the run state is shown');
  assert.equal(await appEvaluate("document.querySelectorAll('.step').length"), 4, 'the plan steps are listed');
  assert.equal(await appEvaluate("document.querySelector('#fill').style.width"), '50%', 'the progress bar reflects the step');
  assert.match(await appEvaluate("document.querySelector('#meta').textContent"), /turns 11\/40/, 'the meta line shows the spend');

  // The action buttons send real messages to the host.
  await appEvaluate("document.querySelector('[data-cmd=\"pause\"]').click()");
  for (let i = 0; i < 100 && appMessages.length < 2; i++) await sleep(50);
  assert.equal(appMessages.length, 2, 'the pause button sends a message');
  assert.match(appMessages[1].content[0].text, /pause/i, 'the pause button asks the agent to pause');

  // The steer field sends what the user typed.
  await appEvaluate("document.querySelector('#instruction').value='skip the docs step'; document.querySelector('#send').click()");
  for (let i = 0; i < 100 && appMessages.length < 3; i++) await sleep(50);
  assert.equal(appMessages.length, 3, 'the steer field sends a message');
  assert.equal(appMessages[2].content[0].text, 'skip the docs step', 'the typed instruction reaches the agent');

  // The panel is a phone-first surface.
  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
    await sleep(120);
    assert.equal(await appEvaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal overflow at ' + width);
    // Only VISIBLE controls count: a hidden button has no box to tap.
    const small = await appEvaluate("[...document.querySelectorAll('.panel button,.panel input,.panel select')].filter(e=>e.offsetParent!==null && e.getBoundingClientRect().height<44).map(e=>[e.id||e.className||e.textContent.trim(), Math.round(e.getBoundingClientRect().height)])");
    assert.deepEqual(small, [], '44px touch targets at ' + width);
  }
  // A capture of the mounted panel, for the docs and for review.
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.cwd(), '.mouaif', 'agent-panel-chat.png'), Buffer.from(shot.data, 'base64'));
  // The panel alone, in the app's own frame.
  await cdp.evaluate("document.querySelector('.mcp-app iframe').scrollIntoView({block:'center'})");
  await sleep(150);
  const panelShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.cwd(), '.mouaif', 'agent-panel.png'), Buffer.from(panelShot.data, 'base64'));
  console.log('agent run control panel: ok');
} finally {
  cdp?.close();
  chrome?.kill();
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  server.closeAllConnections();
  server.close();
}
