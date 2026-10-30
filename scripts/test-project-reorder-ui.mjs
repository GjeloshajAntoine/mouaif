// Browser test: reorder project cards by pressing and holding a card's header.
// Drives the real ProjectsView in a fixture page with synthetic mouse and
// touch input (CDP Input.*), against a mock /api/projects/registered[/order].
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
import { ProjectsView } from './frontend/src/components/Projects.jsx';
import './frontend/src/style.css';
window.__order = ['a', 'b', 'c', 'd'];
window.__puts = [];
window.__failPut = false;
// A native alert would freeze the page; the card raises one when a create-chat fails.
window.__alerts = [];
// Whether the page's scroll was cancelled for each touchmove (window runs after the hook's document listener).
window.__tm = [];
window.addEventListener('touchmove', (e) => window.__tm.push(e.defaultPrevented), { passive: true });
window.alert = (m) => { window.__alerts.push(String(m)); };
const names = { a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta' };
window.fetch = async (input, init) => {
  const url = new URL(input, location.origin);
  const method = (init && init.method) || 'GET';
  let body = {};
  if (url.pathname === '/api/projects/registered/order' && method === 'PUT') {
    const ids = JSON.parse(init.body).ids;
    window.__puts.push(ids);
    if (window.__failPut) return new Response('{}', { status: 500 });
    window.__order = ids;
  } else if (url.pathname === '/api/projects/registered') {
    body = { projects: window.__order.map(id => ({ id, name: names[id], path: '/fixture/' + id })) };
  } else if (url.pathname === '/api/chats') body = { chats: [], total: 0 };
  else if (url.pathname === '/api/prompts') body = { prompts: [] };
  else if (url.pathname === '/api/prompt-profiles') body = { profiles: [] };
  else if (url.pathname === '/api/settings/resolved') body = { resolved: {} };
  return new Response(JSON.stringify(body), { status: 200 });
};
render(h(ProjectsView), document.getElementById('fixture'));
`;
const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false,
  outdir: '/tmp/mouaif-reorder-ui-bundle', format: 'esm', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' } });
const files = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/app.css' : '/app.js', file.text]));
const server = http.createServer((req, res) => {
  if (files[req.url]) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(files[req.url]);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="app"><div class="app__shell"><main id="fixture" class="app__main"></main></div></div><script type="module" src="/app.js"></script></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome is required for the reorder test');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-reorder-ui-'));
  chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 100; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === 'page'); } catch {}
    if (page) break;
    await sleep(100);
  }
  assert.ok(page, 'Chrome started');
  cdp = await createCdp(page.webSocketDebuggerUrl);
  const evaluate = async expression => {
    if (process.env.TRACE) console.error("eval:", expression.slice(0, 90).replace(/\s+/g, " "));
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });

  const order = () => evaluate(`[...document.querySelectorAll('.project-card')].map(c => c.dataset.projectId).join('')`);
  const puts = () => evaluate('JSON.stringify(window.__puts)');
  const lifted = () => evaluate(`!!document.querySelector('.projects__list[data-reordering]') || !!document.querySelector('[data-dragging]')`);
  const leftovers = () => evaluate(`[...document.querySelectorAll('.project-card')].some(c => c.style.translate || c.style.transition || c.hasAttribute('data-dragging')) || document.querySelector('.projects__list').hasAttribute('data-reordering')`);
  // Where a press on a card's title lands.
  const headPoint = id => evaluate(`(() => { const r = document.querySelector('[data-project-id="${id}"] .project-card__identity').getBoundingClientRect(); return { x: r.left + 24, y: r.top + r.height / 2 }; })()`);
  const cardMid = id => evaluate(`(() => { const r = document.querySelector('[data-project-id="${id}"]').getBoundingClientRect(); return r.top + r.height / 2; })()`);

  const input = {
    mouse: (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }),
    touch: (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] })
  };
  const kinds = { mouse: ['mousePressed', 'mouseMoved', 'mouseReleased'], touch: ['touchStart', 'touchMove', 'touchEnd'] };
  // press(from) -> hold -> move to y in steps -> release. `hold` of 0 skips the wait.
  async function drag(kind, from, toY, { hold = 520, release = true } = {}) {
    const [down, move, up] = kinds[kind];
    await input[kind](down, from.x, from.y);
    await sleep(hold);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await input[kind](move, from.x, from.y + (toY - from.y) * i / steps);
      await sleep(24);
    }
    if (release) await input[kind](up, from.x, toY);
  }
  const settled = () => sleep(450);

  for (let i = 0; i < 100 && await evaluate('document.querySelectorAll(".project-card").length') !== 4; i++) await sleep(50);
  assert.equal(await order(), 'abcd', 'four cards rendered');
  await evaluate(`document.querySelectorAll('.project-card').forEach(card => card.getAnimations().forEach(animation => animation.finish()))`);
  // A fresh press target for each case.
  // (The fixture starts a-b-c-d on every load, so a reload is a reset.)
  const reset = async () => {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    for (let i = 0; i < 100 && await evaluate('document.querySelectorAll(".project-card").length') !== 4; i++) await sleep(50);
    await evaluate(`document.querySelectorAll('.project-card').forEach(card => card.getAnimations().forEach(animation => animation.finish()))`);
  };

  for (const kind of ['mouse', 'touch']) {
    if (kind === 'touch') await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    // The window reloads state from the page on every reset; the order lives in
    // the page, so set it before the navigation wipes it.
    await reset();

    // 1. hold + drag down past the third card, release: A goes after C.
    const from = await headPoint('a');
    await drag(kind, from, await cardMid('c') + 6, { release: false });
    assert.equal(await lifted(), true, `${kind}: the card lifts after the hold`);
    const liftedState = await evaluate(`(() => { const a = document.querySelector('[data-project-id="a"]'); return { dragging: a.hasAttribute('data-dragging'), z: getComputedStyle(a).zIndex, others: [...document.querySelectorAll('.project-card:not([data-dragging])')].filter(c => c.style.translate).length }; })()`);
    assert.equal(liftedState.dragging, true, `${kind}: the pressed card is the lifted one`);
    assert.equal(liftedState.z, '3', `${kind}: the lifted card is above the others`);
    assert.ok(liftedState.others >= 2, `${kind}: the cards it passes slide aside (${liftedState.others})`);
    assert.equal(await puts(), '[]', `${kind}: nothing is saved while dragging`);
    if (kind === 'touch') {
      // The hold fired with the finger still, so every move since is ours: the
      // page must not scroll under it. (Moves before the hold stay scrollable.)
      const tm = await evaluate('window.__tm');
      assert.ok(tm.length >= 5 && tm.slice(-5).every(Boolean), 'touch: the page scroll is cancelled while a card is dragged');
    }
    // Watch every frame of the drop: the moved card must not blink (an entrance
    // animation replayed by the DOM move) or jump in size (the lift scale).
    const sampling = evaluate(`new Promise(resolve => {
      const start = performance.now(), heights = [], tops = []; let minOpacity = 1, running = 0;
      (function tick() {
        for (const c of document.querySelectorAll('.project-card')) {
          minOpacity = Math.min(minOpacity, +getComputedStyle(c).opacity);
          if (c.getAnimations().some(a => a instanceof CSSAnimation && a.playState === 'running')) running++;
        }
        heights.push(document.querySelector('[data-project-id="a"]').getBoundingClientRect().height);
        tops.push(Object.fromEntries([...document.querySelectorAll('.project-card')].map(c => [c.dataset.projectId, c.getBoundingClientRect().top])));
        if (performance.now() - start < 900) requestAnimationFrame(tick);
        else resolve({ tops, minOpacity, running, step: Math.max(...heights.slice(1).map((v, i) => Math.abs(v - heights[i]))) });
      })();
    })`);
    await input[kind](kinds[kind][2], from.x, await cardMid('c') + 6);
    const drop = await sampling;
    assert.equal(drop.running, 0, `${kind}: no animation plays on the cards when one is dropped`);
    assert.equal(drop.minOpacity, 1, `${kind}: no card fades while being dropped (blink)`);
    assert.ok(drop.step < 1.2, `${kind}: the card does not jump in size on landing (${drop.step.toFixed(2)}px in one frame)`);
    // Once the dropped card has reached its slot, no card may move again: a
    // card that is displaced for a frame or two (offsets cleared a frame after
    // the DOM was re-ordered) shows up as a card flashing in the wrong place.
    const finalTops = drop.tops[drop.tops.length - 1];
    const landed = drop.tops.findIndex((frame, i) => i > 3 && Math.abs(frame.a - finalTops.a) < 1);
    assert.ok(landed > 0, `${kind}: the dropped card reached its slot`);
    for (const [i, frame] of drop.tops.slice(landed).entries()) {
      for (const id of Object.keys(frame)) {
        assert.ok(Math.abs(frame[id] - finalTops[id]) < 1, `${kind}: card ${id} is off its final place by ${(frame[id] - finalTops[id]).toFixed(0)}px, ${i} frames after landing (flash)`);
      }
    }
    await settled();
    assert.equal(await order(), 'bcad', `${kind}: the card is dropped after the third`);
    assert.equal(await puts(), '[["b","c","a","d"]]', `${kind}: the new order is saved once`);
    assert.equal(await leftovers(), false, `${kind}: no drag styles are left behind`);

    // 2. A tap (no hold) does nothing.
    await reset();
    let p = await headPoint('b');
    await input[kind](kinds[kind][0], p.x, p.y);
    await sleep(60);
    await input[kind](kinds[kind][2], p.x, p.y);
    await settled();
    assert.equal(await lifted(), false, `${kind}: a tap does not lift a card`);
    assert.equal(await puts(), '[]', `${kind}: a tap saves nothing`);

    // 3. Moving before the hold fires is a scroll, not a drag.
    p = await headPoint('b');
    await input[kind](kinds[kind][0], p.x, p.y);
    for (let i = 1; i <= 6; i++) { await input[kind](kinds[kind][1], p.x, p.y + i * 4); await sleep(20); }
    await sleep(600);
    assert.equal(await lifted(), false, `${kind}: moving before the hold cancels it`);
    await input[kind](kinds[kind][2], p.x, p.y + 24);
    await settled();
    assert.equal(await order(), 'abcd', `${kind}: the order did not change`);

    // 4. Holding on the ⋯ button or the "+ New chat" row does not lift anything.
    for (const selector of ['[data-project-id="a"] .project-card__menu-btn', '[data-project-id="a"] .project-card__new']) {
      const pt = await evaluate(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await input[kind](kinds[kind][0], pt.x, pt.y);
      await sleep(600);
      assert.equal(await lifted(), false, `${kind}: holding ${selector.split(' ').pop()} does not lift a card`);
      await input[kind](kinds[kind][2], pt.x, pt.y);
      await sleep(80);
      // The ⋯ tap opens the menu; put it away for the next case.
      await evaluate(`document.querySelectorAll('.project-card__menu-btn[aria-expanded="true"]').forEach(b => b.click())`);
    }

    // 5. Escape while dragging puts the card back and saves nothing.
    await reset();
    const e = await headPoint('a');
    await drag(kind, e, await cardMid('c') + 6, { release: false });
    assert.equal(await lifted(), true, `${kind}: lifted before Escape`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await settled();
    assert.equal(await lifted(), false, `${kind}: Escape drops the lift`);
    assert.equal(await order(), 'abcd', `${kind}: Escape keeps the order`);
    assert.equal(await puts(), '[]', `${kind}: Escape saves nothing`);
    await input[kind](kinds[kind][2], e.x, e.y);
    await settled();
    assert.equal(await order(), 'abcd', `${kind}: the release after Escape does nothing`);

    // 6. Dropping where it started changes nothing and saves nothing.
    const s = await headPoint('b');
    await drag(kind, s, s.y + 3);
    await settled();
    assert.equal(await order(), 'abcd', `${kind}: a drop in place keeps the order`);
    assert.equal(await puts(), '[]', `${kind}: a drop in place saves nothing`);
    assert.equal(await leftovers(), false, `${kind}: no drag styles after a drop in place`);

    // 7. Dragging upward works too: D to the top.
    const dPoint = await headPoint('d');
    await drag(kind, dPoint, await cardMid('a') - 20);
    await settled();
    assert.equal(await order(), 'dabc', `${kind}: dragging up puts D first`);
    assert.equal(await puts(), '[["d","a","b","c"]]', `${kind}: the upward order is saved`);
  }
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // 8. Move up / Move down in the ⋯ menu.
  await reset();
  const menuItems = id => evaluate(`(() => { document.querySelector('[data-project-id="${id}"] .project-card__menu-btn:not(.project-card__filter-btn)').click(); return [...document.querySelectorAll('[data-project-id="${id}"] .project-card__menu-pop:not(.project-card__filter-pop) button')].map(b => b.textContent + (b.disabled ? ':disabled' : '')); })()`);
  assert.deepEqual(await menuItems('a'), ['Settings…', 'Rename…', 'Move up:disabled', 'Move down', 'Unregister'], 'the first card cannot move up');
  await evaluate(`document.querySelector('[data-project-id="a"] .project-card__menu-btn:not(.project-card__filter-btn)').click()`);
  assert.deepEqual((await menuItems('d')).slice(2, 4), ['Move up', 'Move down:disabled'], 'the last card cannot move down');
  await evaluate(`document.querySelector('[data-project-id="d"] .project-card__menu-btn:not(.project-card__filter-btn)').click()`);
  await menuItems('b');
  await evaluate(`[...document.querySelectorAll('[data-project-id="b"] .project-card__menu-pop:not(.project-card__filter-pop) button')].find(b => b.textContent === 'Move down').click()`);
  await settled();
  assert.equal(await order(), 'acbd', 'Move down swaps with the next card');
  assert.equal(await puts(), '[["a","c","b","d"]]', 'Move down is saved');
  const status = await evaluate(`document.querySelector('.page-bar__status').textContent`);
  assert.match(status, /Moved Bravo to 3 of 4/, 'the move is announced in the live status line');
  await menuItems('b');
  await evaluate(`[...document.querySelectorAll('[data-project-id="b"] .project-card__menu-pop:not(.project-card__filter-pop) button')].find(b => b.textContent === 'Move up').click()`);
  await settled();
  assert.equal(await order(), 'abcd', 'Move up swaps back');

  // 9. A failed save puts the list back to what the server has.
  await reset();
  await evaluate('window.__failPut = true');
  const f = await headPoint('a');
  await drag('mouse', f, await cardMid('c') + 6);
  await sleep(900);
  assert.equal(await puts(), '[["b","c","a","d"]]', 'the failing save was attempted');
  assert.equal(await order(), 'abcd', 'a failed save restores the stored order');
  assert.match(await evaluate(`document.querySelector('.page-bar__status').textContent`), /reorder failed/, 'the failure is shown');

  // 10. Dragging near the bottom edge scrolls the page, and the card follows.
  await reset();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 420, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`(() => { const m = document.querySelector('.app__main'); return m.scrollHeight > m.clientHeight + 100; })()`), true, 'the fixture scrolls (inside .app__main) at 420px tall');
  const g = await headPoint('a');
  await drag('mouse', g, 410, { release: false });
  await sleep(900);
  assert.equal(await evaluate(`document.querySelector('.app__main').scrollTop > 50`), true, 'the list auto-scrolls near the bottom edge');
  await input.mouse('mouseReleased', g.x, 410);
  await settled();
  assert.equal(await order(), 'bcda', 'a drop at the end of the scrolled page goes last');
  assert.equal(await leftovers(), false, 'no drag styles after an auto-scrolled drop');
  await evaluate(`document.querySelector('.app__main').scrollTop = 0`);

  // 11. No horizontal overflow, 360 px.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'page fits a 360px viewport');

  console.log('project reorder UI: long-press drag (mouse + touch), tap/scroll/⋯ ignored, Escape, drop in place, Move up/down and failed-save recovery passed');
} finally {
  cdp?.close();
  if (chrome) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await exited; }
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
}
