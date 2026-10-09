// Isolated real-provider editor, mocked device sign-in, mobile tap coverage.
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
import { SettingsProviderEditView } from './frontend/src/components/SettingsProviders.jsx';
import './frontend/src/style.css';
window.errors = [];
window.requests = [];
window.signedIn = false;
window.saved = null;
window.pollStatus = 'pending';
window.pollHttpStatus = 200;
window.addEventListener('error', e => errors.push(e.message));
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
window.fetch = async (url, init = {}) => {
  requests.push({ url, method: init.method || 'GET' });
  let body = {};
  let status = 200;
  if (url === '/api/settings') body = { app: { providers: [] } };
  if (url === '/api/auth/accounts') body = { accounts: { codex: signedIn ? ['me@example.com (workspace)'] : [] } };
  if (url === '/api/auth/device/codex' && init.method === 'POST') body = { id: 'fixture-flow', userCode: 'ABCD-EFGH', verificationUri: 'https://auth.openai.com/codex/device', expiresAt: Date.now() + 900000, status: 'pending' };
  if (url.startsWith('/api/auth/device/codex?id=') && !init.method) {
    if (pollStatus === 'ok') window.signedIn = true;
    status = pollHttpStatus;
    body = status === 200 ? { status: pollStatus, account: 'me@example.com (workspace)' }
      : { error: status === 404 ? 'device sign-in not found' : 'Sign in is required' };
  }
  if (url === '/api/settings/app/providers' && init.method === 'POST') {
    window.saved = JSON.parse(init.body); body = { ok: true };
  }
  return new Response(JSON.stringify(body), { status });
};
render(h(SettingsProviderEditView, {}), document.getElementById('fixture'));
window.ready = true;
`;
const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, outdir: '/tmp/mouaif-codex-ui', format: 'esm',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl' } });
const files = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/app.css' : '/app.js', file.text]));
const server = http.createServer((req, res) => {
  if (files[req.url]) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(files[req.url]);
  } else res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><main class="app__main app__main--flush"><div id="fixture"></div></main><script type="module" src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome required for mobile Codex coverage');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-codex-ui-'));
  chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page'); } catch {}
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Chrome started');
  cdp = await createCdp(page.webSocketDebuggerUrl);
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('UI timed out: ' + expression);
  };
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await waitFor('!!window.ready && !!document.querySelector("#sp-id")');
  await settle();
  await evaluate(`const select = document.querySelector('#sp-id'); select.value = 'codex'; select.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settle();
  const visible = `el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)`;
  assert.equal(await evaluate(`document.querySelector('#sp-key').closest('.row').classList.contains('is-hidden')`), true);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).filter(${visible}).some(el => el.textContent === 'Sign in with ChatGPT code')`), true);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).filter(${visible}).some(el => el.textContent === 'Sign in')`), false);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Sign in with ChatGPT code').click()`);
  await waitFor(`!!document.querySelector('.copilot-device__code')`);
  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await settle();
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `fits ${width}px`);
    const targets = await evaluate(`Array.from(document.querySelectorAll('.copilot-device button, .copilot-device a')).map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, right: r.right }; })`);
    assert.ok(targets.every(r => r.width >= 44 && r.height >= 44 && r.right <= width), `touch targets at ${width}px: ${JSON.stringify(targets)}`);
  }
  assert.equal(await evaluate(`document.querySelector('.copilot-device a').href`), 'https://auth.openai.com/codex/device');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Cancel').click()`);
  await settle();
  assert.equal(await evaluate(`requests.some(r => r.url === '/api/auth/device/codex?id=fixture-flow' && r.method === 'DELETE')`), true);
  for (const [status, message] of [[404, 'The sign-in session was lost. Start sign-in again.'], [401, 'Sign in is required']]) {
    await evaluate(`window.pollHttpStatus = ${status}; Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Sign in with ChatGPT code').click()`);
    await waitFor(`!!document.querySelector('.copilot-device__code')`);
    await waitFor(`document.body.textContent.includes(${JSON.stringify(message)})`);
    assert.equal(await evaluate(`!!document.querySelector('.copilot-device__code')`), false, 'failed polling clears the pending code');
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Sign in with ChatGPT code').disabled`), false, 'failed polling allows a new attempt');
    const count = await evaluate(`requests.filter(r => r.url.includes('/api/auth/device/codex?id=') && r.method === 'GET').length`);
    await evaluate('new Promise(resolve => setTimeout(resolve, 2100))');
    assert.equal(await evaluate(`requests.filter(r => r.url.includes('/api/auth/device/codex?id=') && r.method === 'GET').length`), count, 'failed flow stops polling');
  }
  for (const status of [408, 429, 503]) {
    const count = await evaluate(`requests.filter(r => r.url.includes('/api/auth/device/codex?id=') && r.method === 'GET').length`);
    await evaluate(`window.pollHttpStatus = ${status}; Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Sign in with ChatGPT code').click()`);
    await waitFor(`requests.filter(r => r.url.includes('/api/auth/device/codex?id=') && r.method === 'GET').length > ${count}`);
    await settle();
    assert.equal(await evaluate(`!!document.querySelector('.copilot-device__code')`), true, `HTTP ${status} keeps the flow pending for retry`);
    await evaluate(`Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Cancel').click()`);
    await settle();
  }
  await evaluate(`window.pollHttpStatus = 200; window.pollStatus = 'ok'; Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Sign in with ChatGPT code').click()`);
  await waitFor(`document.body.textContent.includes('signed in as me@example.com')`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Add provider').click()`);
  await waitFor('!!window.saved');
  assert.deepEqual(await evaluate('saved'), { id: 'codex', auth: 'oauth', baseUrl: 'https://chatgpt.com/backend-api/codex' });
  assert.equal(await evaluate(`requests.some(r => r.url.startsWith('/api/auth/sign-in/codex'))`), false);
  assert.deepEqual(await evaluate('errors'), []);
  console.log('PASS Codex mobile UI: select provider, OAuth-only, device link/cancel/sign-in/save at 360/390/430px');
} finally {
  if (cdp) cdp.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill(); await exited;
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
