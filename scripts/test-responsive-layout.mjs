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
          // Its own 28px column right after the reading column: beside the
          // conversation, not over it and not out at the frame edge.
          // With less than a column to spare, it takes the frame edge and the
          // rows give up that strip instead (checked above). Either way it
          // stops at the scrollbar lane rather than sitting on the bar.
          const room = layout.scrollbarLeft - layout.head.right >= 28;
          assert.ok(room ? layout.nav.left >= layout.head.right - 1 && layout.nav.right <= layout.head.right + 29
          : Math.abs(layout.nav.right - layout.scrollbarLeft) < 1,
          `navigation stays beside the conversation, not at the frame edge (head ends ${layout.head.right}, bar starts ${layout.scrollbarLeft}, nav ${layout.nav.left}-${layout.nav.right})`);
          assert.ok(layout.preview, 'web preview rendered');
          assert.ok(layout.preview.right <= layout.composer.right, 'preview stays above the composer, not at the frame edge');
        }
        // The buttons have their own strip: no transcript row runs under
        // any of them, at any width (Latest and its 99+ badge included).
        // Measured while the `99+` badge is showing (see historyNav).
        const { rowsRight, badgeLeft } = historyNav;
        assert.ok(historyNav.buttons.every(button => button.left >= rowsRight) && badgeLeft >= rowsRight,
        `navigation never covers a message at ${width}px / ${fontSize}px (rows end at ${rowsRight}px, `
        + `buttons start at ${Math.min(...historyNav.buttons.map(b => b.left))}px, badge at ${badgeLeft}px)`);
        assert.ok(historyNav.buttons.every(button => button.right <= layout.transcript.right),
        'navigation stays inside the transcript');
        // The rail must not sit on the scrollbar either. It hangs off the
        // transcript box, so before this it landed on the lane a classic
        // scrollbar paints in as soon as the window was narrow enough to
        // hold the rail at the frame edge — and the rail swallowed the
        // drag, because a tap on the bar hit the pill instead.
        assert.ok(historyNav.buttons.every(button => button.right <= historyNav.scrollbarLeft + 0.5),
        `navigation never covers the scrollbar at ${width}px / ${fontSize}px (bar starts at `
        + `${historyNav.scrollbarLeft}px, buttons end at ${Math.max(...historyNav.buttons.map(b => b.right))}px)`);
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
