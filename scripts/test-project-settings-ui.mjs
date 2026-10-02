// Browser regression for project settings. Fake API, real Preact and CSS;
// never touches user settings or restarts the host-managed server.
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
import { SettingsProjectView } from './frontend/src/components/SettingsProject.jsx';
import './frontend/src/style.css';
window.fixture = {
  fail: false, writes: [],
  project: { promptSize: 'extensive', name: 'Mobile fixture', toolOutput: { size: 'full', structure: 'json' } },
  authorization: { tools: { shell: { mode: 'ask', allowlist: [] } }, mcp: { mode: 'ask', servers: {}, tools: {} } }
};
window.fetch = async (input, options = {}) => {
  const endpoint = new URL(input, location.origin).pathname, f = window.fixture;
  let body = {}, status = 200;
  if (options.method === 'PUT') {
    const patch = JSON.parse(options.body); f.writes.push(patch);
    await new Promise(resolve => setTimeout(resolve, 30));
    if (f.fail) status = 503;
    else if (endpoint === '/api/settings/project') {
      const { projectDir, unset = [], ...values } = patch;
      Object.assign(f.project, values);
      for (const key of unset) delete f.project[key];
    } else if (endpoint === '/api/tools/authorization') Object.assign(f.authorization.tools, patch.tools);
  }
  if (endpoint === '/api/settings/project') body = { project: f.project, path: '/fixture/.mouaif.json' };
  else if (endpoint === '/api/settings/resolved') body = { resolved: f.project };
  else if (endpoint === '/api/tools/authorization') body = f.authorization;
  else if (endpoint === '/api/tools/list') body = { tools: [{ name: 'shell', kind: 'native', source: 'shell', description: 'Run shell commands' }] };
  else if (endpoint === '/api/mcp/servers') body = { servers: [] };
  else if (endpoint === '/api/prompts') body = { prompts: [] };
  else if (endpoint === '/api/agents') body = { agents: [] };
  return new Response(JSON.stringify(body), { status });
};
window.showPage = page => render(h(SettingsProjectView, { key: page, projectDir: '/fixture', page }), document.getElementById('fixture'));
window.showPage('output');
`;
const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false,
  outdir: '/tmp/mouaif-project-settings-bundle', format: 'esm', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' } });
const files = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/app.css' : '/app.js', file.text]));
const server = http.createServer((req, res) => {
  if (files[req.url]) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(files[req.url]);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="app"><div class="app__shell"><main id="fixture" class="app__main app__main--flush"></main></div></div><script type="module" src="/app.js"></script></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome is required for the settings UI regression');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-project-settings-ui-'));
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
    const result = await cdp.send('Runtime.evaluate', { expression: `(() => { return eval(${JSON.stringify(expression)}); })()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error('Settings did not settle: ' + expression);
  };
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await wait('document.querySelector("#sp-output-size")?.value === "full"');
  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `page fits ${width}px`);
    assert.equal(await evaluate('Array.from(document.querySelectorAll("select")).every(el => { const r = el.getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.right <= innerWidth; })'), true, 'output controls fit and meet touch minimum');
  }
  await evaluate('fixture.fail = true; const el = document.querySelector("#sp-output-size"); el.value = "average"; el.dispatchEvent(new Event("change", {bubbles:true}))');
  await wait('document.body.textContent.includes("HTTP 503")');
  assert.equal(await evaluate('document.querySelector("#sp-output-size").value'), 'full', 'failed output save restores the native select');
  await evaluate('fixture.fail = false; const el = document.querySelector("#sp-output-size"); el.value = "very-small"; el.dispatchEvent(new Event("change", {bubbles:true}))');
  await wait('fixture.project.toolOutput.size === "very-small" && !document.querySelector("#sp-output-size").disabled');
  assert.deepEqual(await evaluate('fixture.project.toolOutput'), { size: 'very-small', structure: 'json' });

  await evaluate('showPage("main")');
  await wait('document.body.textContent.includes("loaded") && !!document.querySelector(".tool-tree")');
  await evaluate('fixture.fail = true; document.querySelector("input[aria-label=Shell]").click()');
  await wait('document.body.textContent.includes("HTTP 503")');
  assert.equal(await evaluate('document.querySelector("input[aria-label=Shell]").checked'), true, 'failed permission save restores native checkbox');
  await evaluate('fixture.fail = false; document.querySelector("input[aria-label=Shell]").click()');
  await wait('fixture.authorization.tools.shell.mode === "off"');
  assert.equal(await evaluate('document.querySelector("input[aria-label=Shell]").checked'), false);

  await evaluate('showPage("technical")');
  await wait('document.querySelector("#sp-project-editor")?.value.includes("promptSize")');
  await evaluate('const el = document.querySelector("#sp-project-editor"); el.value = JSON.stringify({name:"Mobile fixture"}); el.dispatchEvent(new Event("input", {bubbles:true}))');
  await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent === "Save file").click()');
  await wait('!fixture.project.promptSize && document.querySelector("#sp-project-editor")?.value === JSON.stringify({name:"Mobile fixture"}, null, 2)');
  assert.deepEqual(await evaluate('fixture.project'), { name: 'Mobile fixture' });
  console.log('PASS project settings at 360/390/430px: touch controls, output-size save/retry, permission failure/retry, raw-key removal');
} finally {
  cdp?.close();
  if (chrome) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await exited; }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
}
