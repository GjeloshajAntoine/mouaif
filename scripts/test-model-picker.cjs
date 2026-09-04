// Browser regressions for the shared picker. Requires debug Chrome at CDP_URL
// (default http://127.0.0.1:9222). Uses an isolated about:blank tab, mock models,
// and an in-memory bundle: no running app data or provider requests are touched.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { WebSocket } = require('ws');
const root = path.resolve(__dirname, '..');
const endpoint = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const bundle = await build({
    stdin: {
      contents: `import { h, render } from 'preact';
import { ModelPickerField } from './frontend/src/components/ModelPickerField.jsx';
window.pickerTest = { h, render, ModelPickerField };`,
      resolveDir: root, sourcefile: 'model-picker-test.js'
    }, bundle: true, write: false, format: 'iife', platform: 'browser'
  });
  const target = await (await fetch(endpoint + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + ' timed out')); }, 15000);
    pending.set(key, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const check = async (name, expression) => {
    assert.equal(await evaluate(expression), true, name);
    console.log('  ok - ' + name);
  };
  const wait = () => evaluate('new Promise(resolve => setTimeout(resolve, 80))');
  const point = (selector) => evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  const tap = async (selector, jitter = 0) => {
    const p = await point(selector);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
    if (jitter) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y + jitter }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait();
  };
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const css = ['base.css', 'chat-view.css'].map(f => fs.readFileSync(path.join(root, 'frontend/src', f), 'utf8')).join('\n');
    await evaluate(`document.head.innerHTML = '<meta name="viewport" content="width=device-width,initial-scale=1">';
      document.body.innerHTML = '<div id="fixture"></div><button id="outside">Outside</button>';
      const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.append(style);`);
    await evaluate(bundle.outputFiles[0].text);
    await evaluate(`window.errors = [];
      addEventListener('unhandledrejection', ev => errors.push(String(ev.reason)));
      window.focusCalls = [];
      const nativeFocus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function(options) { focusCalls.push(options); return nativeFocus.call(this, options); };
      window.calls = 0; window.picks = []; window.settle = null; window.failRefresh = null;
      window.models = [{ id: 'alpha', provider: 'one' }, { id: 'beta', provider: 'two' }];
      window.refresh = () => { calls++; return new Promise((resolve, reject) => { settle = resolve; failRefresh = reject; }); };
      window.draw = (overrides = {}) => {
        const { h, render, ModelPickerField } = pickerTest;
        render(h(ModelPickerField, { models, variant: 'sheet', refresh, extraProviders: ['empty'],
          onChange: value => picks.push(value), ...overrides }), document.getElementById('fixture'));
      };
      window.query = text => { const input = document.querySelector('.mp__search'); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); };
      draw();`);
    await tap('.mp__trigger');
    await check('opening focuses search without scrolling', `document.activeElement.matches('.mp__search') && focusCalls.every(o => o?.preventScroll)`);
    await evaluate(`document.querySelectorAll('.mp__chip')[2].click()`); // provider one (All, empty, one, two)
    await wait();
    await evaluate(`query('missing'); window.originalSearch = document.querySelector('.mp__search'); originalSearch.focus({ preventScroll: true });`);
    await wait();
    await check('no matches offers Clear search', `document.querySelector('.mp__empty-action').textContent === 'Clear search'`);
    await tap('.mp__refresh');
    await check('refresh keeps focused input, query, and provider', `calls === 1 && document.activeElement === originalSearch && originalSearch.value === 'missing' && document.querySelector('.mp__chip.is-active .mp__chip-label').textContent === 'one'`);
    await check('refresh is busy and guards duplicate requests', `document.querySelector('.mp__refresh').disabled && document.querySelector('.mp__list').getAttribute('aria-busy') === 'true' && (document.querySelector('.mp__refresh').click(), calls === 1)`);
    await evaluate(`models = models.concat({ id: 'missing-new', provider: 'one' }); draw(); settle();`);
    await wait();
    await check('catalog update preserves search node and displays new match', `document.querySelector('.mp__search') === originalSearch && document.activeElement === originalSearch && document.querySelector('.mp__row-id').textContent === 'missing-new' && !document.querySelector('.mp__refresh').disabled`);
    await evaluate(`query('unknown')`);
    await wait();
    await tap('.mp__empty-action');
    await check('clear only resets text, preserves provider and focus, makes no request', `calls === 1 && originalSearch.value === '' && document.activeElement === originalSearch && document.querySelector('.mp__chip.is-active .mp__chip-label').textContent === 'one' && document.querySelectorAll('.mp__row').length === 2`);
    await tap('.mp__refresh');
    await evaluate(`failRefresh(new Error('offline'));`);
    await wait();
    await check('failed refresh is retryable and keeps catalog', `!document.querySelector('.mp__refresh').disabled && document.querySelector('[role="alert"]').textContent.includes('Try again') && document.querySelectorAll('.mp__row').length === 2 && errors.length === 0`);
    await tap('.mp__refresh');
    await evaluate(`document.querySelector('.mp__search').blur(); settle();`);
    await wait();
    await check('refresh completion does not reopen keyboard', `document.activeElement !== originalSearch && !document.querySelector('[role="alert"]')`);
    await evaluate(`document.querySelectorAll('.mp__chip')[1].click(); query('   ');`);
    await wait();
    await check('empty provider with whitespace offers Refresh models', `document.querySelector('.mp__empty-title').textContent === 'No models for this provider' && document.querySelector('.mp__empty-action').textContent === 'Refresh models'`);
    await tap('.mp__empty-action');
    await check('empty-state refresh fetches once', 'calls === 4');
    await evaluate('settle()');
    await wait();

    // Deterministic visual viewport simulation for keyboard pan/resize/close.
    await evaluate(`window.nativeVV = window.visualViewport;
      window.vv = new EventTarget(); Object.assign(vv, { height: 410, offsetTop: 30 });
      document.querySelector('.mp__close').click();`);
    await wait();
    await evaluate(`Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv }); void 0;`);
    await tap('.mp__trigger');
    await check('sheet fits the keyboard viewport before focus', `(() => { const r = document.querySelector('.mp__pop').getBoundingClientRect(); return Math.abs(r.bottom - 440) < 1 && r.top >= 30; })()`);
    await evaluate(`vv.height = 844; vv.offsetTop = 0; vv.dispatchEvent(new Event('resize'));`);
    await check('keyboard dismissal resizes sheet back to visible bottom', `Math.abs(document.querySelector('.mp__pop').getBoundingClientRect().bottom - 844) < 1`);
    await evaluate(`vv.offsetTop = 12; vv.dispatchEvent(new Event('scroll'));`);
    await check('viewport pan updates position', `Math.abs(document.querySelector('.mp__pop').getBoundingClientRect().bottom - 856) < 1`);
    await evaluate(`document.querySelector('.mp__close').click();`);
    await wait();
    await evaluate(`Object.defineProperty(window, 'visualViewport', { configurable: true, value: nativeVV }); void 0;`);
    await tap('.mp__trigger');
    await evaluate(`document.querySelectorAll('.mp__chip')[2].click(); query('alpha');`);
    await wait();
    await check('phone search avoids small-input focus zoom', `parseFloat(getComputedStyle(document.querySelector('.mp__search')).fontSize) >= 16`);
    await tap('.mp__row', 1);
    await check('1px touch jitter selects a short-list row', `picks.length === 1 && picks[0].modelId === 'alpha' && !document.querySelector('.mp__pop')`);
    await tap('.mp__trigger');
    await evaluate(`query(''); document.querySelector('.mp__chip').click(); models = Array.from({ length: 80 }, (_, i) => ({ id: 'model-' + String(i).padStart(2, '0'), provider: 'one' })); draw();`);
    await wait();
    const start = await point('.mp__list');
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: start.y - i * 20 }] });
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait();
    await check('native touch swipe scrolls model list, not page', `document.querySelector('.mp__list').scrollTop > 0 && window.scrollY === 0 && picks.length === 1`);
    for (const width of [360, 430, 1280]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 480 });
      await wait();
      await check('picker fits at width ' + width, `(() => { const r = document.querySelector('.mp__pop').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.height > 0 && r.bottom <= innerHeight + 1; })()`);
    }
    await evaluate(`document.querySelector('.mp__close').click()`);
    await wait();
    await check('close restores trigger focus without page scrolling', `document.activeElement.matches('.mp__trigger') && focusCalls.every(o => o?.preventScroll) && window.scrollY === 0`);
    await tap('.mp__trigger');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await wait();
    await check('Escape closes and restores focus', `!document.querySelector('.mp__pop') && document.activeElement.matches('.mp__trigger')`);
    console.log('\nModel picker browser regressions passed.');
  } finally {
    ws.close();
    await fetch(endpoint + '/json/close/' + target.id);
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
