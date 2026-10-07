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
    import { loadPinned, togglePin, migrateProjectScopedBookmarks } from './frontend/src/components/chat/modelPicker.js';
    window.pickerTest = { h, render, ModelPickerField,
    loadPinned, togglePin, migrateProjectScopedBookmarks };`,
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
    const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.append(style);
    // about:blank denies the real localStorage. Install an in-memory shim so the
    // shared pin list can be exercised without touching any origin's storage.
    {
      const store = new Map();
      Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      getItem: k => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem: (k, v) => store.set(String(k), String(v)),
      removeItem: k => store.delete(String(k)),
      clear: () => store.clear(),
      key: i => Array.from(store.keys())[i] || null,
      get length() { return store.size; }
      } });
      }
      void 0;`);
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
    await check('no matches offers Refresh models first and separate Clear search', `Array.from(document.querySelectorAll('.mp__empty-action'), el => el.textContent).join('|') === 'Refresh models|Clear search'`);
    await tap('.mp__empty-action');
    await check('no-match refresh keeps focused input, query, and provider', `calls === 1 && document.activeElement === originalSearch && originalSearch.value === 'missing' && document.querySelector('.mp__chip.is-active .mp__chip-label').textContent === 'one'`);
    await check('both refresh actions are busy and guard duplicate requests', `document.querySelector('.mp__refresh').disabled && document.querySelector('.mp__empty-action').disabled && document.querySelector('.mp__empty-action').textContent === 'Refreshing…' && !document.querySelector('.mp__empty-action--clear').disabled && document.querySelector('.mp__list').getAttribute('aria-busy') === 'true' && (document.querySelector('.mp__refresh').click(), document.querySelector('.mp__empty-action').click(), calls === 1)`);
    await evaluate(`models = models.concat({ id: 'missing-new', provider: 'one' }); draw(); settle();`);
    await wait();
    await check('catalog update preserves search node and displays new match', `document.querySelector('.mp__search') === originalSearch && document.activeElement === originalSearch && document.querySelector('.mp__row-id').textContent === 'missing-new' && !document.querySelector('.mp__refresh').disabled`);
    await evaluate(`query('unknown')`);
    await wait();
    await tap('.mp__empty-action--clear');
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
    await evaluate(`query('still-missing');`);
    await wait();
    await tap('.mp__empty-action');
    await evaluate('settle()');
    await wait();
    await check('no-match refresh with keyboard viewport preserves filters and geometry', `calls === 5 && document.activeElement.matches('.mp__search') && document.activeElement.value === 'still-missing' && document.querySelector('.mp__chip.is-active .mp__chip-label').textContent === 'empty' && document.querySelector('.mp__empty-title').textContent === 'No matches' && document.querySelector('.mp__empty-action').textContent === 'Refresh models' && Math.abs(document.querySelector('.mp__pop').getBoundingClientRect().bottom - 440) < 1`);
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
    await evaluate(`query('no-matches');`);
    await wait();
    for (const width of [360, 430, 1280]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 480 });
      await wait();
      await check('picker fits at width ' + width, `(() => { const r = document.querySelector('.mp__pop').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.height > 0 && r.bottom <= innerHeight + 1; })()`);
      await check('empty-state actions are visible touch targets at width ' + width, `Array.from(document.querySelectorAll('.mp__empty-action')).every(el => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth && el.contains(hit); })`);
    }
    await evaluate(`draw({ refresh: undefined });`);
    await wait();
    await check('picker without refresh support still allows clearing search', `!document.querySelector('.mp__refresh') && document.querySelectorAll('.mp__empty-action').length === 1 && document.querySelector('.mp__empty-action').textContent === 'Clear search'`);
    await evaluate(`document.querySelector('.mp__close').click()`);
    await wait();
    await check('close restores trigger focus without page scrolling', `document.activeElement.matches('.mp__trigger') && focusCalls.every(o => o?.preventScroll) && window.scrollY === 0`);
    await tap('.mp__trigger');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait();
    await check('Escape closes and restores focus', `!document.querySelector('.mp__pop') && document.activeElement.matches('.mp__trigger')`);
    await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
    await tap('.mp__trigger');
    await check('landscape phone stays in viewport-bounded modal mode', `(() => { const pop = document.querySelector('.mp__pop'), r = pop.getBoundingClientRect(); return pop.matches(':modal') && getComputedStyle(pop).position === 'fixed' && Math.abs(r.bottom - visualViewport.height) < 1 && r.width === innerWidth && getComputedStyle(document.querySelector('.mp__search')).fontSize === '16px'; })()`);
    const searchPoint = await point('.mp__search');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...searchPoint, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });
    await wait();
    await check('dragging from search onto backdrop does not dismiss', `document.querySelector('.mp__pop').matches(':modal')`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });
    await wait();
    await check('tapping modal backdrop closes and restores trigger', `!document.querySelector('.mp__pop') && document.activeElement.matches('.mp__trigger')`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluate(`const box = document.createElement('div'); box.id = 'scroller'; box.style.cssText = 'height:700px;overflow:auto';
      const fixture = document.getElementById('fixture'); fixture.before(box); box.append(fixture);
      fixture.style.cssText = 'padding-top:900px;height:2000px'; box.scrollTop = 600;`);
    await tap('.mp__trigger');
    await evaluate(`window.openTop = document.querySelector('.mp__pop').getBoundingClientRect().top;
      document.getElementById('scroller').scrollTop = 1000;
      document.querySelector('.mp__close').focus({ preventScroll: true });`);
    await wait();
    await check('background ancestor scroll followed by focus cannot reposition open dialog', `document.querySelector('.mp__pop').getBoundingClientRect().top === openTop`);

    // ---- Recommended rows ------------------------------------------------
    // The dictation page passes the rows worth reaching first (see
    // recommendedModels). They get their own section above the provider
    // sections, and a row that Pinned/Recent already shows is not repeated.
    //
    // Self-contained: the cases above leave an open dialog, a re-parented
    // fixture and their own catalog behind, and the scroll case above leaves
    // the trigger off-screen, so this one starts from a fresh fixture and draws
    // its own two models rather than inheriting any of it.
    await evaluate(`{
    document.body.innerHTML = '<div id="fixture"></div>';
    draw({ models: [{ id: 'alpha', provider: 'one' }, { id: 'beta', provider: 'two' }],
      recommended: [{ id: 'beta', provider: 'two' }], pinned: new Set(['one\u0000alpha']) });
    }`);
    await wait();
    await tap('.mp__trigger');
    await check('recommended rows get their own section, in the caller\'s order', `(() => {
    const titles = Array.from(document.querySelectorAll('.mp__section-title')).map(el => el.textContent);
    return titles[0] === 'Recommended' && titles[1] === 'Pinned';
    })()`);
    await check('recommended drops rows the pinned section already shows', `(() => {
    const sections = Array.from(document.querySelectorAll('.mp__section'));
    const ids = section => Array.from(section.querySelectorAll('.mp__row-id')).map(el => el.textContent);
    const recommended = sections.find(s => s.querySelector('.mp__section-title').textContent === 'Recommended');
    const pinnedSection = sections.find(s => s.querySelector('.mp__section-title').textContent === 'Pinned');
    return ids(recommended).join(',') === 'beta' && ids(pinnedSection).join(',') === 'alpha';
    })()`);
    // A query narrows the list to matches, and a "worth reaching first" section
    // over a deliberately narrowed list would be noise rather than help.
    await evaluate(`query('bet');`);
    await wait();
    await check('recommended hides while a search is narrowing the list', `(() => {
    const titles = Array.from(document.querySelectorAll('.mp__section-title')).map(el => el.textContent);
    return !titles.includes('Recommended') && titles.includes('two');
    })()`);
    await evaluate(`query('');`);

    // ---- Bookmarks survive an empty / unloaded catalog -------------------
    // The chat picker opens from whatever the project model list already holds
    // and refreshes the live catalogs in the background, so the first paint can
    // have no models at all. Pinned and Recent rows are the user's own record
    // and used to be filtered against that empty catalog, which left the sheet
    // showing "No models yet" with the recent model the user was looking for
    // nowhere in it. Both sections must render their row regardless, and the
    // empty-state card must not claim there are no models over them.
    await evaluate(`{
    document.body.innerHTML = '<div id="fixture"></div>';
    draw({ models: [], pinned: new Set(['one\u0000alpha']),
    recent: [{ provider: 'two', id: 'beta' }, { provider: 'three', id: 'gamma' }] });
    }`);
    await wait();
    await tap('.mp__trigger');
    await check('bookmarks render with an empty catalog while live models load', `(() => {
    const titles = Array.from(document.querySelectorAll('.mp__section-title')).map(el => el.textContent);
    const ids = title => {
    const section = Array.from(document.querySelectorAll('.mp__section'))
      .find(s => s.querySelector('.mp__section-title').textContent === title);
    return section ? Array.from(section.querySelectorAll('.mp__row-id'), el => el.textContent) : [];
    };
    return titles.join(',') === 'Pinned,Recent' &&
    ids('Pinned').join(',') === 'alpha' && ids('Recent').join(',') === 'beta,gamma';
    })()`);
    await check('an unresolved recent row still names its provider', `(() => {
    const row = Array.from(document.querySelectorAll('.mp__row'))
    .find(el => el.querySelector('.mp__row-id').textContent === 'gamma');
    return row.querySelector('.mp__row-meta').textContent === 'three';
    })()`);
    await check('a bookmarked-only sheet does not claim there are no models', `(() => {
    const empty = document.querySelector('.mp__empty');
    return !empty || empty.querySelector('.mp__empty-title').textContent !== 'No models yet';
    })()`);
    // A genuinely empty sheet still says so, so the empty state keeps its job.
    await evaluate(`document.body.innerHTML = '<div id="fixture"></div>'; draw({ models: [], pinned: new Set(), recent: [] });`);
    await wait();
    await tap('.mp__trigger');
    await check('an actually empty sheet still reports no models', `document.querySelector('.mp__empty-title').textContent === 'No models yet'`);
    // A pinned row the catalog does carry keeps its label.
    await evaluate(`{
    document.body.innerHTML = '<div id="fixture"></div>';
    draw({ models: [{ id: 'alpha', provider: 'one', label: 'Alpha label' }], pinned: new Set(['one\u0000alpha']) });
    }`);
    await wait();
    await tap('.mp__trigger');
    await check('a pinned row resolved against the catalog keeps its label', `(() => {
    const row = document.querySelector('.mp__row');
    return row.querySelector('.mp__row-id').textContent === 'alpha' &&
    row.querySelector('.mp__row-label').textContent === 'Alpha label';
    })()`);

    // ---- The list is app-wide, not per project --------------------------
    // Both sections used to be namespaced by the chat's project dir (pins by a
    // localStorage key, recents by a `project_dir` column), so every project
    // started from an empty list and the model just used in one was missing in
    // the next. The helpers must now read and write ONE shared list.
    await evaluate(`{
    localStorage.clear();
    pickerTest.togglePin('one', 'alpha');
    }`);
    await check('pins are stored under one key with no project namespace', `(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    return keys.includes('mouaif_models_pinned') &&
    !keys.some(k => /^mouaif_models_.+_pinned$/.test(k)) &&
    pickerTest.loadPinned().has('one\\u0000alpha');
    })()`);
    // The one-shot fold: per-project keys an older build wrote are merged into
    // the shared list rather than orphaned.
    await evaluate(`{
    localStorage.clear();
    localStorage.setItem('mouaif_models__home_me_alpha_pinned', JSON.stringify(['one\\u0000alpha']));
    localStorage.setItem('mouaif_models__home_me_beta_pinned', JSON.stringify(['two\\u0000beta']));
    pickerTest.migrateProjectScopedBookmarks();
    }`);
    await check('pins from every project are folded onto the shared list', `(() => {
    const pinned = pickerTest.loadPinned();
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    return pinned.has('one\\u0000alpha') && pinned.has('two\\u0000beta') &&
    !keys.some(k => /^mouaif_models_.+_pinned$/.test(k));
    })()`);
    await check('a later unpin is not revived by the next fold', `(() => {
    pickerTest.togglePin('one', 'alpha');            // unpin
    pickerTest.migrateProjectScopedBookmarks();      // runs again
    return !pickerTest.loadPinned().has('one\\u0000alpha') &&
    pickerTest.loadPinned().has('two\\u0000beta');
    })()`);
    console.log('\nModel picker browser regressions passed.');
  } finally {
    ws.close();
    await fetch(endpoint + '/json/close/' + target.id);
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
