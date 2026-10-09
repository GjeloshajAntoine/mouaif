// Real StylesPanel + production CSS: phone geometry, light-theme contrast,
// section navigation and the inline editor. No live target or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { contrast } from '../frontend/src/components/inspector/contrast.js';
const require = createRequire(import.meta.url);
const { findChrome, createCdp, freePort } = require('./lib/capture-fixture.js');
const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
    import { h, render } from 'preact';
    import { StylesPanel } from './frontend/src/components/inspector/StylesPanel.jsx';
    import './frontend/src/style.css';
    import './frontend/src/inspector.css';
    const values = { display: 'flex', padding: '16px', color: 'rgb(40, 42, 45)',
      'background-color': 'rgb(243, 243, 241)', 'border-radius': '12px',
      '--a-very-long-custom-property-name-that-must-never-hide-the-value': 'var(--another-long-token, 12px)' };
    const rows = () => Object.entries(values).map(([prop, value]) => ({ prop, value }));
    const model = () => ({ objectId: 'fixture', node: { nodeName: 'SECTION', attributes: [{ name: 'id', value: 'hero' }, { name: 'class', value: 'card' }] },
      box: { width: 320, height: 180 }, bases: { root: 16, parent: 16, self: 16 },
      inlineProps: rows(), inlineCss: Object.entries(values).map(([p,v]) => p+':'+v+';').join(''),
      computed: [...rows(), { prop: 'font-size', value: '16px' }] });
    window.writes = [];
    window.handles = { current: null };
    window.mount = () => render(h('div', { class: 'inspector__panel inspector__panel--solo', 'data-panel': 'styles' },
      h('div', { class: 'inspector__panel-head' }, h('strong', null, 'Styles')),
      h('div', { class: 'inspector__panel-body' }, h(StylesPanel, {
        panelHandlesRef: window.handles, previewVisible: false,
        selectBySelector: async selector => { if (selector === '.missing') throw Error('No matching element'); return model(); },
        refreshNodeModel: async () => model(),
        setInlineStyleProperty: async (id, prop, value) => { values[prop] = value; window.writes.push({ prop, value }); return {}; },
        readElementStyles: async () => ({ inline: { ...values }, computed: { ...values }, cssText: model().inlineCss }),
        readElementTree: async () => ({ ancestors: [{ label: 'main#app', levels: 1 }], children: [{ label: 'h2.title' }], childCount: 1 }),
        readMatchedRules: async () => ({ rules: [{ id: 'rule-1', selector: '.card', group: 'author', props: [{ name: 'padding', value: '16px' }] }], counts: { author: 1, userAgent: 0 } })
      }))), document.getElementById('app'));
    window.mount(); window.ready = true;
  ` }, bundle: true, write: false, outdir: '/tmp/mouaif-styles-bundle', format: 'esm',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }
});
const files = Object.fromEntries(bundle.outputFiles.map(file => ['/' + path.basename(file.path), file.text]));
const server = http.createServer((req, res) => {
  const body = files[req.url];
  res.writeHead(200, { 'Content-Type': body ? (req.url.endsWith('.css') ? 'text/css' : 'text/javascript') : 'text/html' });
  res.end(body || '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/stdin.css"></head><body><div id="app"></div><script type="module" src="/stdin.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome required');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-styles-'));
  chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(p => p.type === 'page'); } catch {}
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Chrome started');
  cdp = await createCdp(page.webSocketDebuggerUrl);
  const evaluate = async expression => {
    const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result.value;
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  const click = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); };
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
  for (let i = 0; i < 100 && !await evaluate('!!window.ready'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate('!!window.ready'), true);
  const setSelector = async value => {
    await evaluate(`(() => { const el = document.querySelector('.inspector__styles-sel'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await settle(); await click('.inspector__styles-sel-go');
  };
  await setSelector('.missing');
  assert.match(await evaluate('document.querySelector("[role=alert]").textContent'), /No matching element/);
  await setSelector('.card');
  assert.equal(await evaluate('!!document.querySelector(".inspector__styles-elem")'), true, 'selection renders');

  const checkLayout = async label => {
    const result = await evaluate(`(() => {
      const panel = document.querySelector('.inspector__styles');
      const controls = [...panel.querySelectorAll('button, input:not([type=checkbox]), select, summary')]
        .filter(el => el.getClientRects().length && !el.disabled);
      return { overflow: panel.scrollWidth - panel.clientWidth,
        small: controls.filter(el => { const r = el.getBoundingClientRect(); return r.width < 43.9 || r.height < 43.9; }).map(el => el.className),
        clipped: controls.filter(el => el.scrollWidth > el.clientWidth + 2 && !el.closest('.inspector__styles-crumbs')).map(el => el.className) };
    })()`);
    assert.ok(result.overflow <= 1, label + ' no horizontal overflow');
    assert.deepEqual(result.small, [], label + ' 44px touch targets');
    assert.deepEqual(result.clipped, [], label + ' controls do not clip text');
  };
  for (const [width, fontSize] of [[360, 16], [390, 16], [430, 16], [768, 16], [360, 20]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
    await evaluate(`document.documentElement.style.fontSize = '${fontSize}px'`);
    await settle();
    for (let group = 0; group < 6; group++) {
      await click('.inspector__touch-tab:nth-child(' + (group + 1) + ')');
      await checkLayout(width + '/' + fontSize + ' group ' + group);
    }
    await click('.inspector__styles-jump-chip:nth-child(2)');
    const geometry = await evaluate(`(() => {
      const rail = document.querySelector('.inspector__styles-jump').getBoundingClientRect();
      const heading = [...document.querySelectorAll('.inspector__styles-h')].find(el => el.textContent === 'Declared styles').getBoundingClientRect();
      return { rail: rail.bottom, heading: heading.top, panel: document.querySelector('.inspector__styles').getBoundingClientRect().bottom };
    })()`);
    assert.ok(geometry.heading >= geometry.rail && geometry.heading < geometry.panel, 'section heading clears sticky chrome');
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("document.documentElement.style.fontSize = '16px'");
  await click('.inspector__styles-row--declared .inspector__styles-row-main');
  await checkLayout('editor');
  const tokens = await evaluate(`(() => {
    const css = getComputedStyle(document.querySelector('.inspector__value-editor'));
    return Object.fromEntries(['surface','surface-2','surface-3','fg','fg-soft','muted','muted-2','accent','border-strong'].map(k => [k, css.getPropertyValue('--'+k).trim()]));
  })()`);
  for (const surface of ['surface', 'surface-2', 'surface-3']) {
    for (const text of ['fg', 'fg-soft', 'muted', 'muted-2', 'accent']) assert.ok(contrast(tokens[text], tokens[surface]).ratio >= 4.5, text + ' AA text contrast');
    assert.ok(contrast(tokens['border-strong'], tokens[surface]).ratio >= 3, 'control contrast');
  }
  await evaluate(`(() => { const el = document.querySelector('#inspector-edit-value'); el.value = 'grid'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await settle(); await click('.inspector__style-apply');
  assert.deepEqual(await evaluate('window.writes'), [{ prop: 'display', value: 'grid' }], 'Apply still writes just the selected property');
  await click('.inspector__value-editor-head .btn');
  assert.equal(await evaluate('!!document.querySelector(".inspector__value-editor")'), false, 'Done returns to styles');
  await click('.inspector__rules-toggle');
  await checkLayout('expanded matched rules');
  // Fullscreen must still fill the available viewport, not retain the card's
  // 72dvh height. Use the real fullscreen wrapper/height cascade.
  await evaluate(`(() => {
    const panel = document.querySelector('.inspector__panel');
    const surface = document.createElement('div'); surface.className = 'inspector__fs';
    panel.parentNode.appendChild(surface); surface.appendChild(panel);
    panel.classList.add('inspector__panel--grow', 'inspector__panel--fullscreen');
  })()`);
  await settle(); await checkLayout('fullscreen');
  const fullscreenHeight = await evaluate('document.querySelector(".inspector__styles").getBoundingClientRect().height');
  assert.ok(fullscreenHeight > 700 && fullscreenHeight < 844, 'fullscreen fills available height');
  if (process.env.STYLES_SCREENSHOT) {
    await click('.inspector__touch-tab:first-child');
    await click('.inspector__styles-jump-chip:first-child');
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.STYLES_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  console.log('PASS Styles mobile: 360–768px, enlarged text, all groups, rules, inline edit, navigation and AA contrast');
} finally {
  cdp?.close(); chrome?.kill(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (profile) {
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
