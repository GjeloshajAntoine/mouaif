// Browser regression for the real app shell on phones, tablets, and desktops.
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

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
    import { h, render } from 'preact';
    import { App } from './frontend/src/components/App.jsx';
    import { route } from './frontend/src/api.js';
    import { publish } from './frontend/src/components/chat/webpreviewState.js';
    import './frontend/src/style.css';
    const project = { id: 'p1', name: 'Responsive fixture', path: '/tmp/responsive' };
    const messages = Array.from({ length: 40 }, (_, seq) => ({ seq,
      role: seq % 2 ? 'assistant' : 'user', ts: Date.now(),
      content: 'Message ' + seq + ' ' + 'A readable message on every screen. '.repeat(20) }));
    window.fetch = async url => {
      const pathname = new URL(String(url), location.href).pathname;
      let body = {};
      if (pathname === '/api/projects') body = { projects: [project] };
      if (pathname === '/api/chats') body = { chats: [{ id: 'c1', name: 'Responsive chat' }], total: 1 };
      if (pathname === '/api/chats/c1') body = { chat: { id: 'c1', name: 'Responsive chat', tools: null } };
      if (pathname === '/api/chats/c1/messages') body = { messages, total: messages.length, hasMore: false, nextSeq: messages.length };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    window.EventSource = class { close() {} addEventListener() {} };
    window.mountRoute = name => { route.value = { name, chatId: 'c1', projectDir: project.path }; };
    window.showPreview = () => publish({ thumbnail: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="375" height="667"/>'), url: 'https://example.test' });
    render(h(App), document.getElementById('app'));
    window.ready = true;
  ` },
  bundle: true, splitting: true, write: false, outdir: '/tmp/mouaif-responsive-bundle', format: 'esm',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }
});
const files = {};
for (const file of bundle.outputFiles) {
  const name = path.basename(file.path);
  if (name.endsWith('.css')) files['/app.css'] = (files['/app.css'] || '') + file.text;
  else files[name === 'stdin.js' ? '/app.js' : '/' + name] = file.text;
}
const server = http.createServer((req, res) => {
  const file = files[req.url];
  res.writeHead(200, { 'Content-Type': file ? (req.url.endsWith('.css') ? 'text/css' : 'text/javascript') : 'text/html' });
  res.end(file || '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome is required for the responsive regression');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-responsive-'));
  chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
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
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 100 && !await evaluate('!!window.ready'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate('!!window.ready'), true, 'app rendered');
  for (const name of ['chats', 'settings', 'settingsDefaults', 'settingsDictation', 'settingsPrompts', 'chat']) {
    await evaluate(`window.mountRoute('${name}')`);
    for (let i = 0; i < 100 && !await evaluate('!!document.querySelector(".app__main > section")'); i++) await new Promise(resolve => setTimeout(resolve, 50));
    if (name === 'chat') await evaluate('window.showPreview()');
    await new Promise(resolve => setTimeout(resolve, 200));
    for (const [width, height, fontSize] of [
    ...[360, 390, 430, 768, 900, 1024, 1280, 1920].map(width => [width, 800, 16]),
    [360, 640, 20], [768, 600, 20], [1280, 600, 20], [1920, 900, 20]
    ]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    await evaluate(`document.documentElement.style.fontSize = '${fontSize}px'`);
    await settle();
      const layout = await evaluate(`(() => {
      const rect = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const main = document.querySelector('.app__main');
      const navEl = document.querySelector('.chat-view__scroll-nav');
      return { shell: rect('.app__shell'), main: rect('.app__main'),
      content: rect('.app__main > section'), head: rect('.chat-view__head'),
      composer: rect('.chat-view__composer-row'), transcript: rect('.chat-view__transcript'),
      row: rect('.chat-view__transcript > .chat-msg'), nav: rect('.chat-view__scroll-nav'),
      // The lane the transcript's scrollbar paints in. The rail hangs off
      // the transcript box, which shares the transcript's bounds, so this
      // is where the bar sits relative to the rail.
      scrollbarLeft: (() => {
      const t = document.querySelector('.chat-view__transcript');
      if (!t) return null;
      const lane = t.offsetWidth - t.clientWidth - t.clientLeft;
      return t.getBoundingClientRect().right - lane;
      })(),
      // '' when the rail is a normal flex row (a real bar), 'absolute'
      // when it floats over the transcript. The overlay is the point.
      navFloat: navEl ? getComputedStyle(navEl).position : null,
      // The rail's resting clearance, and the grid level it is lifted by:
      // the slot size plus the gap between stacked slots. One level above
      // the resting clearance is where the bottom pill settles.
      navMetrics: navEl ? (() => {
      const cs = getComputedStyle(navEl);
      const slot = parseFloat(cs.getPropertyValue('--nav-col'));
      const gap = parseFloat(cs.getPropertyValue('--nav-gap'));
      return { bottom: parseFloat(cs.bottom), slot, gap, level: slot + gap };
      })() : null,
      navButtons: [...document.querySelectorAll('.chat-view__nav-btn')].filter(button => button.getClientRects().length).map(button => {
      const r = button.getBoundingClientRect();
      // The ::before grows the hit area past the painted 26px control.
      const before = getComputedStyle(button, '::before');
      const insetX = parseFloat(before.left) + parseFloat(before.right);
      const insetY = parseFloat(before.top) + parseFloat(before.bottom);
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
      tabIndex: button.tabIndex, disabled: button.disabled, text: button.textContent,
      hit: { width: r.width - insetX, height: r.height - insetY } };
      }),
      preview: rect('.webpreview-dock'),
      overflow: main.scrollWidth - main.clientWidth };
      })()`);
      assert.ok(layout.content, `${name} renders its actual view`);
      if (name === 'settingsDictation' && width >= 720) {
      assert.ok(layout.content.width <= 42.5 * fontSize, 'dictation keeps its own readable desktop measure');
      assert.ok(Math.abs(layout.content.left - (width - layout.content.width) / 2) < 1, 'dictation is centred');
      }
      if (name === 'settingsPrompts') {
      // The toggle switch paints a 42x26 track and a 20x20 thumb inside a
      // 44x44 hit box. A duplicated `.switch__track` rule once stretched
      // the track with `inset: 0` and re-anchored it to the box's content
      // origin, so it escaped the control to the left (`left: -11px`) and
      // painted half off-screen at 390px. Assert the geometry, not just
      // "the page renders".
      const sw = await evaluate(`(() => {
      const control = document.querySelector('.prompts__quick-launch .switch');
      if (!control) return null;
      const box = control.getBoundingClientRect();
      const inside = (r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5
        && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
      const track = control.querySelector('.switch__track');
      const thumb = control.querySelector('.switch__thumb');
      const t = track.getBoundingClientRect();
      const h = thumb.getBoundingClientRect();
      return { box: { w: box.width, h: box.height },
        trackInside: inside(t), thumbInside: inside(h),
        trackLeft: t.left, trackRight: t.right, viewport: window.innerWidth };
      })()`);
      assert.ok(sw, 'the prompt editor renders the project-card switch');
      assert.ok(sw.box.w >= 44 && sw.box.h >= 44, 'the switch keeps its 44px tap target');
      assert.ok(sw.trackInside, 'the switch track stays inside its control');
      assert.ok(sw.thumbInside, 'the switch thumb stays inside its control');
      assert.ok(sw.trackLeft >= 0 && sw.trackRight <= sw.viewport, 'the switch paints inside the viewport');
      }
      assert.ok(layout.overflow <= 1, `${name} fits horizontally at ${width}px / ${fontSize}px font`);
      assert.ok(Math.abs(layout.shell.width - Math.min(width, 72 * fontSize)) < 1, 'shell grows with the viewport up to its ceiling');
      assert.ok(Math.abs(layout.shell.left - (width - layout.shell.width) / 2) < 1, 'shell is centred');
      assert.ok(layout.main.bottom <= height, 'content stays inside the viewport');
      if (name === 'chat') {
      // Composer accessory buttons must keep the shared chromeless styling,
      // including after lazy Inspector CSS has joined the page's cascade.
      const imageButton = await evaluate(`(() => {
      const button = document.querySelector('.chat-view__image-btn');
      if (!button) return null;
      const css = getComputedStyle(button);
      const mic = getComputedStyle(document.querySelector('.chat-view__mic-btn'));
      const r = button.getBoundingClientRect();
      return { background: css.backgroundColor, border: css.borderTopWidth,
        radius: css.borderTopLeftRadius, color: css.color, micColor: mic.color,
        width: r.width, height: r.height };
      })()`);
      assert.ok(imageButton, 'image import button is present');
      assert.equal(imageButton.background, 'rgba(0, 0, 0, 0)', 'image button keeps its transparent background');
      assert.equal(imageButton.border, '0px', 'image button has no browser-default border');
      assert.equal(imageButton.radius, '50%', 'image button keeps its round shape');
      assert.equal(imageButton.color, imageButton.micColor, 'image and microphone glyphs share the same color');
      assert.ok(Math.abs(imageButton.width - imageButton.height) < 1, 'image button stays square');
      assert.ok(layout.transcript.height > 200, 'transcript fills available height');
        assert.ok(layout.composer.bottom <= height, 'composer remains visible');
        assert.ok(Math.abs(layout.head.left - layout.composer.left) < 1, 'chat controls share a column');
        // The rail is an overlay, not a row: it must not take reading
        // height from the transcript or sit in its own barred strip.
        assert.equal(layout.navFloat, 'absolute', 'the rail floats over the transcript instead of taking its own bar');
        assert.ok(layout.transcript.bottom >= layout.nav.top - 1, 'the rail floats over the transcript, taking no row of its own');
        assert.ok(layout.transcript.bottom >= layout.nav.bottom - 1, 'the rail hangs inside the transcript, not below it');
        // The real proof that the rail is no longer a bar: the transcript
        // still reaches whatever sits below it (the preview dock when one
        // is open, else the composer). A reserved nav row left a gap here.
        // The real proof that the rail is no longer a bar: the transcript
        // still reaches the surface below it, and any gap is the surface's
        // own top margin — never a reserved navigation row. The preview dock
        // carries a 0.4rem top margin of its own; the composer a 6px pad.
        const belowTranscript = layout.preview && layout.preview.top < layout.composer.top ? layout.preview.top : layout.composer.top;
        const ownGap = layout.preview && layout.preview.top < layout.composer.top ? 0.4 * fontSize : 6;
        assert.ok(Math.abs(layout.transcript.bottom - (belowTranscript - ownGap)) < 1, 'the transcript reaches the surface below it: the rail reserves no row');
        assert.ok(layout.nav.bottom <= layout.composer.top + 1, 'navigation stays above the composer');
        // The rail floats one full grid level above its resting clearance:
        // the bottom pill is Latest, so its slot plus the gap above it are
        // clear air below the rail. Measured as geometry, so a stray
        // `bottom` value that puts the rail back against the composer (or
        // halfway up the transcript) fails here.
        const { bottom: railBottom, level } = layout.navMetrics;
        assert.ok(railBottom >= 24 && level > 0, `the rail keeps a resting clearance (bottom ${railBottom}px, level ${level}px)`);
        assert.ok(Math.abs((layout.transcript.bottom - layout.nav.bottom) - railBottom) < 1.5,
        `the rail floats its clearance above the transcript's bottom edge at ${width}px / ${fontSize}px `
        + `(clearance ${(layout.transcript.bottom - layout.nav.bottom).toFixed(1)}px, expected ${railBottom}px)`);
        assert.ok(Math.abs(railBottom - (24 + level)) < 0.6,
        `the rail's clearance is one grid level above its 24px rest at ${width}px / ${fontSize}px `
        + `(bottom ${railBottom}px, 24 + level ${level} = ${24 + level}px)`);
        assert.equal(layout.navButtons.length, 2, 'pinned history keeps Prev and Next in fixed slots');
        assert.equal(layout.navButtons[1].disabled, true, 'Next is disabled while following latest');
        assert.equal(layout.navButtons[0].text, '', 'previous message carries no visible label');
        assert.equal(layout.navButtons[1].text, '', 'next message carries no visible label');
        for (const button of layout.navButtons) {
        // A compact column: the hit area fills its 28px slot around a 20px pill.
        assert.ok(button.hit.width >= 28 && button.hit.height >= 28, 'navigation fills its 28px slot as a hit area');
        assert.ok(button.width <= 20 && button.height <= 20, 'the painted control stays compact');
        assert.equal(button.tabIndex, 0, 'navigation buttons support keyboard focus');
        assert.ok(button.left >= 0 && button.right <= width, 'navigation targets stay inside the viewport');
        }
        // Keyboard users can reach message navigation; Space scrolls when
        // the transcript has focus and activates a button when it has focus.
        // Start after the transcript's many message-action buttons, rather
        // than depending on how many copy buttons fit in 25 Tab presses.
        await evaluate(`document.querySelector('.chat-view__transcript').focus({ preventScroll: true })`);
        const reached = [];
        for (let i = 0; i < 100; i++) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        const at = await evaluate(`(() => { const a = document.activeElement; return a ? (a.className || a.tagName) : null; })()`);
        if (at) reached.push(at);
        if (String(at).includes('chat-view__nav-btn--prev')) break;
        }
        assert.equal(reached.some(name => String(name).includes('chat-view__nav-btn--prev')), true,
        'Tab reaches Previous message');
        // Use the arrow to unpin before testing native transcript scrolling.
        await evaluate(`document.querySelector('.chat-view__nav-btn--prev').click()`);
        await settle();
        await evaluate(`(() => { const t = document.querySelector('.chat-view__transcript'); t.scrollTop = 0; t.focus({ preventScroll: true }); return true; })()`);
        await settle();
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', unmodifiedText: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        await settle();
        // Native keyboard scrolling can start after more than two frames,
        // even with reduced motion. Wait for movement, not an animation guess.
        for (let i = 0; i < 20 && !await evaluate(`document.querySelector('.chat-view__transcript').scrollTop > 0`); i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(await evaluate(`document.querySelector('.chat-view__transcript').scrollTop`) > 0,
        'Space scrolls a focused transcript: ' + JSON.stringify(await evaluate(`(() => {
        const t = document.querySelector('.chat-view__transcript');
        return { width: innerWidth, focus: document.activeElement.className, top: t.scrollTop,
        height: t.scrollHeight, viewport: t.clientHeight, overflow: getComputedStyle(t).overflowY,
        mode: document.querySelector('.chat-view__scroll-nav').dataset.mode };
        })()`)));
        // Let native keyboard-scroll animation finish before repinning, so
        // its remaining frames cannot race the subsequent Previous tap.
        await new Promise(resolve => setTimeout(resolve, 300));
        await evaluate(`document.querySelector('.chat-view__jump').click()`);
        await settle();
        await new Promise(resolve => setTimeout(resolve, 100));
        await evaluate(`document.querySelector('.chat-view__nav-btn--prev').click()`);
        await settle();
        const historyNav = await evaluate(`(() => {
        const nav = document.querySelector('.chat-view__scroll-nav');
        document.querySelector('.chat-view__jump-count').textContent = '99+';
        const buttons = [...nav.querySelectorAll('button')].filter(button => button.getClientRects().length);
        const transcript = document.querySelector('.chat-view__transcript');
        const nr = nav.getBoundingClientRect();
        const badge = document.querySelector('.chat-view__jump-count').getBoundingClientRect();
        const rowsRight = Math.max(...[...transcript.children].map(r => r.getBoundingClientRect()).filter(r => r.width).map(r => r.right));
        // The scrollbar lane is painted inside the transcript's content box,
        // but the rail hangs off the transcript box, which shares those
        // bounds. Subtract the left lane (clientLeft) from the total inset
        // to leave the lane the bar is actually drawn in.
        const scrollbarLane = transcript.offsetWidth - transcript.clientWidth - transcript.clientLeft;
        const scrollbarLeft = transcript.getBoundingClientRect().right - scrollbarLane;
        return { mode: nav.dataset.mode, bottom: nr.bottom, top: nr.top, badgeLeft: badge.width ? badge.left : -1, rowsRight,
        scrollbarLane, scrollbarLeft, navRight: nr.right,
        inside: nr.top >= transcript.getBoundingClientRect().top - 1 && nr.bottom <= transcript.getBoundingClientRect().bottom + 1,
        buttons: buttons.map(button => {
        const r = button.getBoundingClientRect();
        const before = getComputedStyle(button, '::before');
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
        disabled: button.disabled, text: button.textContent,
        hitW: r.width - parseFloat(before.left) - parseFloat(before.right),
        hitH: r.height - parseFloat(before.top) - parseFloat(before.bottom),
        hit: button.contains(document.elementFromPoint(r.left + 2, r.top + r.height / 2)) };
        }) };
        })()`);
        assert.equal(historyNav.mode, 'free', 'Previous unpins the transcript');
        assert.equal(historyNav.buttons.length, 3, 'history shows Previous, Next and Bottom');
        // Compare the actual buttons, not just the cluster's bottom edge.
        // Latest and its badge must never displace the repeat-tap targets.
        assert.ok(Math.abs(historyNav.bottom - layout.nav.bottom) < 1, 'the rail keeps its bottom anchor');
        assert.ok(Math.abs(historyNav.top - layout.nav.top) < 1, 'the rail reserves a stable Latest slot');
        for (let i = 0; i < 2; i++) {
        assert.ok(Math.abs(historyNav.buttons[i].top - layout.navButtons[i].top) < 1, 'message target stays at the same vertical position');
        assert.ok(Math.abs(historyNav.buttons[i].left - layout.navButtons[i].left) < 1, 'message target stays at the same horizontal position');
        }
        assert.equal(historyNav.buttons[1].disabled, false, 'Next enables in history');
        assert.equal(historyNav.buttons[2].text, '99+', 'the unread badge is the only text on Latest');
        assert.ok(historyNav.inside, 'the rail stays inside the transcript box');
        for (let i = 0; i < historyNav.buttons.length; i++) {
        const button = historyNav.buttons[i];
        assert.ok(button.hitW >= 28 && button.hitH >= 28, 'every navigation control fills its 28px slot');
        assert.ok(button.hit, 'the painted control is itself clickable');
        assert.ok(button.left >= 0 && button.right <= width, 'unread count fits inside the viewport');
        for (const other of historyNav.buttons.slice(0, i)) {
        assert.ok(button.top >= other.bottom || button.bottom <= other.top
        || button.left >= other.right || button.right <= other.left, 'navigation targets never overlap');
        }
        }
        // A second tap at the exact original coordinates must still hit
        // Prev, not Latest. Exercise real hit testing rather than .click().
        const prevPoint = layout.navButtons[0];
        const beforeRepeat = await evaluate(`document.querySelector('.chat-view__transcript').scrollTop`);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1,
        x: prevPoint.left + prevPoint.width / 2, y: prevPoint.top + prevPoint.height / 2 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1,
        x: prevPoint.left + prevPoint.width / 2, y: prevPoint.top + prevPoint.height / 2 });
        await settle();
        assert.ok(await evaluate(`document.querySelector('.chat-view__transcript').scrollTop`) < beforeRepeat,
        'repeat tap at the same position goes to an earlier message');
        assert.equal(await evaluate(`document.querySelector('.chat-view__scroll-nav').dataset.mode`), 'free',
        'repeat Previous never accidentally returns to Latest');
        await evaluate(`document.querySelector('.chat-view__jump').focus()`);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        await settle();
        assert.equal(await evaluate(`document.querySelector('.chat-view__scroll-nav').dataset.mode`), 'pinned', 'Latest resumes following replies');
        assert.equal(await evaluate(`document.activeElement.className`), 'chat-view__transcript', 'Latest returns focus to the transcript');
        if (width >= 48 * fontSize) {
        assert.ok(Math.abs(layout.row.left - layout.head.left) < 1, 'transcript stays centred even with a scrollbar');
        // Past the wide breakpoint the reading column ends before the rail,
        // so the rail sits just right of it. Below that breakpoint the
        // column has no room to spare, and the rail takes the scrollbar's
        // lane with the last row running under it — see the cover check
        // below. Either way it stops at the bar rather than sitting on it.
        const room = Math.min(layout.scrollbarLeft, width) - layout.head.right >= 28;
        assert.ok(room ? layout.nav.left >= layout.head.right - 1 && layout.nav.right <= layout.head.right + 29
        : Math.abs(layout.nav.right - Math.min(layout.scrollbarLeft, width)) < 1,
        `navigation sits at the reading column's edge when there is room, else on the bar's lane (head ends ${layout.head.right}, bar starts ${layout.scrollbarLeft}, nav ${layout.nav.left}-${layout.nav.right})`);
        assert.ok(layout.preview, 'web preview rendered');
        assert.ok(layout.preview.right <= layout.composer.right, 'preview stays above the composer, not at the frame edge');
        }
        // Nothing is reserved for the rail any more. Measured as geometry, not
        // by toggling the rail's display: hiding it used to leave the rows
        // exactly where they were, so that check could never fail.
        const railClosed = historyNav.buttons[0].left;
        assert.ok(historyNav.badgeLeft >= railClosed - 0.5,
        `the rail's badge stays inside its column at ${width}px / ${fontSize}px (badge at ${historyNav.badgeLeft}px, `
        + `column starts at ${railClosed}px), so the covered corner never widens`);
        assert.ok(Math.abs(historyNav.badgeLeft - railClosed) < 6,
        `the badge sits on the pill's corner, not beside the rail (badge at ${historyNav.badgeLeft}px, column at ${railClosed}px)`);
        // Below the wide breakpoint the rail is the widest thing the rows can
        // meet: the rail is one 28px column, so the worst a row's bottom
        // corner loses is that column. Above it, the rail sits at the reading
        // column's edge and no row reaches it at all.
        // The rows must still reach the reading column exactly. As an upper
        // bound this assertion could never fail — the whole point is that the
        // rows are no longer shortened to leave the rail a strip.
        const readingColumnRight = Math.min(layout.head.right, historyNav.scrollbarLeft - 8);
        assert.ok(historyNav.rowsRight >= readingColumnRight - 1,
        `rows reach the reading column at ${width}px / ${fontSize}px (row ends at ${historyNav.rowsRight}px, `
        + `column ends at ${readingColumnRight}px — the rail reserves no strip)`);
        // The rail covers the last row's bottom-right corner below the wide
        // breakpoint: that is the deliberate trade. It must therefore stay a
        // small, corner-anchored cluster — never a full-width bar, and never
        // taller than its three slots — and it must leave the row's text
        // measure intact.
        assert.ok(Math.abs(historyNav.buttons[0].left - historyNav.buttons[1].left) < 1
          && Math.abs(historyNav.buttons[2].left - historyNav.buttons[0].left) < 1,
          'the rail stays one column wide, so it covers a corner and not a band');
        assert.ok(historyNav.buttons.every(button => button.right <= layout.transcript.right),
        'navigation stays inside the transcript');
        // The rail must not sit on the scrollbar. It hangs off the
        // transcript box while the bar is painted inside the scroller nested
        // in it, so this is where a 28px rail used to overlap the bar by 2px
        // and swallow its drag. Tested in the arrangement that actually has
        // a bar: a classic one over a wide frame.
        if (historyNav.scrollbarLane > 0) {
        assert.ok(historyNav.buttons.every(button => button.right <= historyNav.scrollbarLeft + 0.5),
        `navigation never covers the scrollbar at ${width}px / ${fontSize}px (bar starts at `
        + `${historyNav.scrollbarLeft}px, buttons end at ${Math.max(...historyNav.buttons.map(b => b.right))}px)`);
        }
        // The bar is genuinely draggable: a pointer press on the lane just
        // left of the thumb must land on the scroller, not on a pill.
        if (historyNav.scrollbarLane > 0) {
        const onBar = await evaluate(`(() => {
        const t = document.querySelector('.chat-view__transcript');
        const r = t.getBoundingClientRect();
        const lane = t.offsetWidth - t.clientWidth - t.clientLeft;
        const x = r.right - lane / 2;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, hit: hit ? (hit.closest('.chat-view__nav-btn') ? 'nav-btn' : hit.className || hit.tagName) : null };
        })()`);
        assert.ok(!String(onBar.hit).includes('nav-btn'),
        `the scrollbar lane stays draggable at ${width}px (elementFromPoint at x=${onBar.x} hit ${onBar.hit})`);
        }
        if (width <= 430) {
        assert.ok(Math.abs(layout.preview.right - (width - 0.75 * fontSize)) < 1, 'phone preview keeps its existing inset');
        }
      }
      if (name === 'settingsDefaults') {
        assert.equal(await evaluate(`(() => {
          const section = document.querySelector('.app__main > section');
          section.scrollTop = section.scrollHeight;
          return section.scrollHeight <= section.clientHeight || section.scrollTop > 0;
        })()`), true, 'flush settings still scroll to the bottom');
      }
    }
    console.log('PASS responsive ' + name);
  }
  console.log('PASS responsive app layout');
} finally {
  cdp?.close();
  chrome?.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (profile) {
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
