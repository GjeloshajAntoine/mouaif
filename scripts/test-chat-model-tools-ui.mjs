// Real mobile tool trees, with an isolated catalog and no user-store writes.
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
const { SPECS } = require('../src/tools/mouaif.js');
const catalog = ['search_models', 'create_chat', 'update_chat', 'change_working_folder', 'start_chat'].map(name => ({
  name, kind: 'native', source: 'chats', description: SPECS[name].function.description
}));
const contents = `
import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import { ToolTree, buildToolGroups } from './frontend/src/components/ToolTree.jsx';
import { ToolPopup } from './frontend/src/components/chat/ToolPopup.jsx';
import './frontend/src/style.css';
const catalog = ${JSON.stringify(catalog)};
function Fixture() {
  const [filter, setFilter] = useState(null);
  function toggle(names, checked) {
    setFilter(current => {
      const next = new Set(current || catalog.map(t => t.name));
      names.forEach(name => checked ? next.add(name) : next.delete(name));
      return [...next];
    });
  }
  return h('main', null,
    h('header', { class: 'chat-view__head' },
      h('div', { class: 'chat-view__title-stack' },
        h('div', { class: 'chat-view__meta' }, 'folder: /home/user/a-very-long-project-name/.mouaif/workspaces/1234abcd')),
      h(ToolPopup, { tools: { catalog, filter }, toolAuth: { chats: { mode: 'ask' } },
        onToggleTool: (name, checked) => toggle([name], checked), onToggleToolGroup: toggle })),
    h(ToolTree, { groups: buildToolGroups(catalog, [], filter),
      onToggleTool: (group, name, checked) => toggle([name], checked),
      onToggleGroup: (group, checked) => toggle(catalog.map(t => t.name), checked) }));
}
render(h(Fixture), document.getElementById('fixture'));
window.ready = true;
`;
const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, outdir: '/tmp/mouaif-model-tool-ui', format: 'esm',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl' } });
const files = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/app.css' : '/app.js', file.text]));
const server = http.createServer((req, res) => {
  if (files[req.url]) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(files[req.url]);
  } else {
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="fixture"></div><script type="module" src="/app.js"></script></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome required for mobile model tools coverage');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-model-tools-ui-'));
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 100 && !await evaluate('!!window.ready'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate('!!window.ready'), true);
  await evaluate('document.querySelector(".tool-popup__trigger").click()');
  await settle();
  // Expand both the Tools card's shared tree and the composer popup tree.
  await evaluate('document.querySelectorAll(".tool-tree__chev").forEach(el => el.click())');
  await settle();
  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await settle();
    await evaluate('document.querySelectorAll(".tool-tree__group").forEach(group => { if (!group.querySelector(".tool-tree__row--leaf")) group.querySelector(".tool-tree__chev")?.click(); })');
    await settle();
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `fits ${width}px`);
    const trees = await evaluate(`Array.from(document.querySelectorAll('.tool-tree')).map(tree => ({
      labels: Array.from(tree.querySelectorAll('.tool-tree__row--leaf')).map(el => el.textContent),
      targets: Array.from(tree.querySelectorAll('.tool-tree__row--leaf')).map(el => {
        const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right <= innerWidth;
      })
    }))`);
    assert.equal(trees.length, 2);
    for (const tree of trees) {
      assert.equal(tree.labels.length, 5);
      assert.ok(tree.labels.some(label => label.includes('change_working_folder')));
      assert.ok(tree.labels.some(label => label.includes('search_models')));
      assert.ok(tree.labels.some(label => label.includes('start_chat')));
      assert.ok(tree.targets.every(Boolean), 'tool rows are visible and fit the viewport');
    }
  }
  console.log('PASS model/working-folder mobile UI: shared Tools card/composer trees and long folder metadata at 360/390/430px');
} finally {
  if (cdp) cdp.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
  }
  await new Promise(resolve => server.close(resolve));
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
