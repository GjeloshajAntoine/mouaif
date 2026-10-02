// Browser regression: nested tool checkboxes must share their parent's column.
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
import { useState } from 'preact/hooks';
import { ToolTree, buildToolGroups } from './frontend/src/components/ToolTree.jsx';
import { ToolPopup } from './frontend/src/components/chat/ToolPopup.jsx';
import './frontend/src/style.css';
const catalog = ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'group_read', 'group_edit']
  .map(name => ({ name, kind: 'native', source: 'files', description: 'A long file-tool description that should truncate without moving the checkbox.' }));
function Fixture() {
  const [filter, setFilter] = useState(null);
  function toggle(names, checked) {
    setFilter(current => {
      const next = new Set(current || catalog.map(tool => tool.name));
      names.forEach(name => checked ? next.add(name) : next.delete(name));
      return [...next];
    });
  }
  return h('main', null,
    h('header', { class: 'chat-view__head', style: { padding: '0.625rem' } },
      h(ToolPopup, { tools: { catalog, filter }, toolAuth: { file: { mode: 'allow' } },
        onToggleTool: (name, checked) => toggle([name], checked), onToggleToolGroup: toggle })),
    ...['transcript', 'settings'].map(id => h('section', { id, style: { padding: '0.625rem' } },
      h(ToolTree, { groups: buildToolGroups(catalog, [], filter),
        onToggleTool: (group, name, checked) => toggle([name], checked),
        onToggleGroup: (group, checked) => toggle(catalog.map(tool => tool.name), checked) }))));
}
render(h(Fixture), document.getElementById('fixture'));
window.ready = true;
`;
const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false,
  outdir: '/tmp/mouaif-tool-tree-bundle', format: 'esm', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' } });
const files = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/app.css' : '/app.js', file.text]));
const server = http.createServer((req, res) => {
  if (files[req.url]) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(files[req.url]);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="fixture"></div><script type="module" src="/app.js"></script></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome is required for the layout regression');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-tool-tree-ui-'));
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
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 100 && !await evaluate('!!window.ready'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate('!!window.ready'), true, 'fixture rendered');
  await evaluate('document.querySelector(".tool-popup__trigger").click()');
  await settle();
  await evaluate('document.querySelector(".tool-popup__tree .tool-tree__chev").click()');
  await settle();
  for (const width of [360, 390, 430, 768, 1280]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
    for (const fontSize of [16, 20]) {
      await evaluate(`document.documentElement.style.fontSize = '${fontSize}px'`);
      await settle();
      const trees = await evaluate(`Array.from(document.querySelectorAll('.tool-tree')).map(tree => {
        const parent = tree.querySelector('.tool-tree__group > .tool-tree__row');
        const childRows = Array.from(tree.querySelectorAll('.tool-tree__row--leaf'));
        const left = (row, selector) => row.querySelector(selector).getBoundingClientRect().left;
        return { children: childRows.length,
          checkboxOffsets: childRows.map(row => left(row, '.checkbox') - left(parent, '.checkbox')),
          nameOffsets: childRows.map(row => left(row, '.tool-tree__name') - left(parent, '.tool-tree__name')),
          overflow: tree.scrollWidth > tree.clientWidth };
      })`);
      assert.equal(trees.length, 3, 'popup, transcript, and settings use the shared tree');
      for (const tree of trees) {
        assert.equal(tree.children, 7, 'all file tools rendered');
        assert.ok(tree.checkboxOffsets.every(offset => Math.abs(offset) < 0.1), `checkbox columns align at ${width}px / ${fontSize}px font: ${tree.checkboxOffsets}`);
        assert.ok(tree.nameOffsets.every(offset => Math.abs(offset) < 0.1), 'tool names align with the group name');
        assert.equal(tree.overflow, false, 'tree has no horizontal overflow');
      }
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'page fits the viewport');
    }
  }
  await evaluate('document.querySelector(".tool-popup__tree .tool-tree__row--leaf .tool-tree__name").click()');
  await settle();
  assert.equal(await evaluate('document.querySelector(".tool-popup__tree .tool-tree__count").textContent'), '7/7', 'text taps remain inert');
  await evaluate('document.querySelector(".tool-popup__tree .tool-tree__row--leaf .checkbox").click()');
  await settle();
  assert.equal(await evaluate('document.querySelector(".tool-popup__tree .tool-tree__count").textContent'), '6/7', 'child checkbox toggles only that tool');
  assert.equal(await evaluate('document.querySelector(".tool-popup__tree .tool-tree__group > .tool-tree__row .checkbox").indeterminate'), true, 'parent shows partial selection');
  await evaluate('document.querySelector(".tool-popup__tree .tool-tree__chev").click()');
  await settle();
  assert.equal(await evaluate('document.querySelector(".tool-popup__tree .tool-tree__children")'), null, 'chevron collapses the child list');
  assert.equal(await evaluate('document.querySelector(".tool-popup__tree .tool-tree__count").textContent'), '6/7', 'collapse preserves selection');
  console.log('tool tree layout: aligned checkboxes and names at 360–1280px, enlarged text, toggles, and collapse passed');
} finally {
  cdp?.close();
  if (chrome) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await exited; }
  await new Promise(resolve => server.close(resolve));
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
}
