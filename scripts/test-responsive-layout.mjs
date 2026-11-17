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
    [360, 640, 20], [768, 600, 20], [1280, 600, 20], [1920, 900, 20],
    // Foldables: the narrowest cover screens (Flip/Fold cover at 320/344 px),
    // the near-square inner screen of a book-style fold in both
    // orientations, and the larger 7.6–8 in inner panels.
    [320, 568, 16], [344, 882, 16], [690, 830, 16], [830, 690, 16], [884, 1104, 16], [344, 600, 20], [690, 830, 20]
    ]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    await evaluate(`document.documentElement.style.fontSize = '${fontSize}px'`);
    await settle();
      const layout = await evaluate(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const rect = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const main = document.querySelector('.app__main');
      const navEl = document.querySelector('.chat-view__scroll-nav');
      const layout = { shell: rect('.app__shell'), main: rect('.app__main'),
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
      // The rail's anchor: the share of the transcript's height its centre
      // hangs at, so the folded dots land there and the four slots grow
      // evenly around them.
      navMetrics: navEl ? (() => {
      const cs = getComputedStyle(navEl);
      const slot = parseFloat(cs.getPropertyValue('--nav-col'));
      const gap = parseFloat(cs.getPropertyValue('--nav-gap'));
      return { topPx: parseFloat(cs.top), bottom: cs.bottom, anchor: 35, slot, gap, level: slot + gap };
      })() : null,
      // 'false' while the rail rests as folded dots, 'true' once it unfolds.
      navExpanded: navEl ? navEl.dataset.expanded : null,
      // The strip the folded rail carries as its own tap target, since the
      // buttons' hit areas fold down with them.
      navStrip: navEl ? (() => {
      const before = getComputedStyle(navEl, '::before');
      return { width: parseFloat(before.width), height: parseFloat(before.height), pointerEvents: before.pointerEvents };
      })() : null,
      // The rail rests folded, so measure that state as the resting one; the
      // unfolded slots are the repeat-tap targets, measured second.
      navButtons: [], foldedNavButtons: [],
      preview: rect('.webpreview-dock'),
      overflow: main.scrollWidth - main.clientWidth };
      if (navEl) {
      const measure = () => [...document.querySelectorAll('.chat-view__nav-btn')].filter(button => button.getClientRects().length).map(button => {
      const r = button.getBoundingClientRect();
      // The ::before grows the hit area past the painted 26px control.
      const before = getComputedStyle(button, '::before');
      const insetX = parseFloat(before.left) + parseFloat(before.right);
      const insetY = parseFloat(before.top) + parseFloat(before.bottom);
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
      tabIndex: button.tabIndex, disabled: button.disabled, text: button.textContent,
      glyph: Number(getComputedStyle(button.querySelector('svg')).opacity),
      hit: { width: r.width - insetX, height: r.height - insetY } };
      });
      // Transitions are 240ms; wait them out rather than reading a sliver of
      // the fold mid-flight.
      navEl.dataset.expanded = 'false';
      await wait(320);
      layout.foldedNavButtons = measure();
      navEl.dataset.expanded = 'true';
      await wait(320);
      layout.navButtons = measure();
      navEl.dataset.expanded = 'false';
      await wait(320);
      }
      return layout;
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
        assert.ok(layout.transcript.top <= layout.nav.top - 1 && layout.transcript.bottom >= layout.nav.bottom - 1,
        'the rail hangs inside the transcript, not above or below it');
        // The real proof that the rail is no longer a bar: the transcript
        // still reaches the surface below it, and any gap is the surface's
        // own top margin — never a reserved navigation row. The preview dock
        // carries a 0.4rem top margin of its own; the composer a 6px pad.
        const belowTranscript = layout.preview && layout.preview.top < layout.composer.top ? layout.preview.top : layout.composer.top;
        const ownGap = layout.preview && layout.preview.top < layout.composer.top ? 0.4 * fontSize : 6;
        assert.ok(Math.abs(layout.transcript.bottom - (belowTranscript - ownGap)) < 1, 'the transcript reaches the surface below it: the rail reserves no row');
        // The rail is anchored, not edge-stuck: it sits at 35% of the
        // transcript's height and its centre is unfolded around that point,
        // so the folded dots land there and the four slots grow evenly
        // around them. A stray `bottom` (the old bottom-anchored rail) fails
        // here, as does a rail that drifts with the folded/expanded state.
        const { topPx, anchor } = layout.navMetrics;
        assert.ok(Math.abs(topPx - layout.transcript.height * (anchor / 100)) < 1,
        `the rail hangs off ${anchor}% of the transcript's height at ${width}px / ${fontSize}px `
        + `(top ${topPx}px, ${anchor}% of ${layout.transcript.height.toFixed(1)}px)`);
        assert.ok(Math.abs(layout.nav.top + layout.nav.height / 2
        - (layout.transcript.top + layout.transcript.height * (anchor / 100))) < 1.5,
        `the rail's centre sits at its anchor at ${width}px / ${fontSize}px `
        + `(centre ${(layout.nav.top + layout.nav.height / 2).toFixed(1)}px, `
        + `anchor ${(layout.transcript.top + layout.transcript.height * (anchor / 100)).toFixed(1)}px)`);
        // Four slots, top to bottom: Top, Prev, Next, Latest. Prev and Next
        // keep fixed grid slots, so an appearing Latest or a growing badge
        // never moves either message target.
        assert.equal(layout.navButtons.length, 3, 'pinned history keeps Top, Prev and Next');
        assert.equal(layout.navButtons[2].disabled, true, 'Next is disabled while following latest');
        assert.equal(layout.navButtons[0].text, '', 'the top control carries no visible label');
        assert.equal(layout.navButtons[1].text, '', 'previous message carries no visible label');
        // Folded by default: the rail rests as a short strip of dots, and the
        // folded buttons paint no glyph. Their hidden hit areas fold with
        // them, which is why the folded rail carries a strip of its own.
        assert.equal(layout.navExpanded, 'false', 'the rail starts folded at mid-height');
        assert.ok(layout.foldedNavButtons.length > 0
        && layout.foldedNavButtons.every(button => button.width < 8 && button.height < 8),
        'the folded controls shrink to dots');
        assert.ok(layout.foldedNavButtons.every(button => button.glyph === 0),
        'the folded controls paint no glyph');
        assert.equal(layout.navStrip.width, 28, 'the folded rail keeps a 28px-wide strip to tap');
        assert.ok(layout.navStrip.height >= 40 && layout.navStrip.height <= 48,
        `the folded strip stays a small target (${layout.navStrip.height}px tall)`);
        assert.equal(layout.navStrip.pointerEvents, 'auto', 'the folded strip itself takes the tap');
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
        // Focusing a control unfolds the rail, so the target a keyboard user
        // is about to activate is the one they can see.
        assert.equal(await evaluate(`document.querySelector('.chat-view__scroll-nav').dataset.expanded`), 'true',
        'focusing a navigation control unfolds the rail');
        await evaluate(`document.activeElement.blur()`);
        await settle();
        // Use the arrow to unpin before testing native transcript scrolling.
        await evaluate(`document.querySelector('.chat-view__scroll-nav').dataset.expanded = 'true'`);
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
        const historyNav = await evaluate(`(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const nav = document.querySelector('.chat-view__scroll-nav');
        const transcript = document.querySelector('.chat-view__transcript');
        // Measure both states from the settled layout, not mid-transition.
        const scan = () => [...nav.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => {
        const r = button.getBoundingClientRect();
        const before = getComputedStyle(button, '::before');
        const glyph = getComputedStyle(button.querySelector('svg')).opacity;
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
        disabled: button.disabled, text: button.textContent, glyph: Number(glyph),
        hitW: r.width - parseFloat(before.left) - parseFloat(before.right),
        hitH: r.height - parseFloat(before.top) - parseFloat(before.bottom),
        hit: button.contains(document.elementFromPoint(r.left + 2, r.top + r.height / 2)) };
        });
        nav.dataset.expanded = 'false';
        await wait(320);
        const folded = scan();
        const foldedRect = nav.getBoundingClientRect();
        nav.dataset.expanded = 'true';
        await wait(320);
        // Set the unread count last: scroll bookkeeping rewrites it while the
        // fold animates, and only the settled state matters here.
        document.querySelector('.chat-view__jump-count').textContent = '99+';
        const expanded = scan();
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
        scrollbarLane, scrollbarLeft, navRight: nr.right, foldedTop: foldedRect.top, foldedHeight: foldedRect.height,
        inside: nr.top >= transcript.getBoundingClientRect().top - 1 && nr.bottom <= transcript.getBoundingClientRect().bottom + 1,
        folded, expanded };
        })()`);
        assert.equal(historyNav.mode, 'free', 'Previous unpins the transcript');
        assert.equal(historyNav.expanded.length, 4, 'history shows Top, Previous, Next and Latest');
        // The rail's own box is the same in both states: only the buttons
        // fold into it, so unfolding never shifts the grid or the rows.
        assert.ok(Math.abs(historyNav.foldedTop - historyNav.top) < 1, 'the rail keeps its anchor when folded');
        assert.ok(Math.abs(historyNav.foldedHeight - layout.nav.height) < 1, 'the rail keeps its height when folded');
        // A second tap must land on the same target: the expanded slots are
        // where they were, whatever the folded state did to the buttons.
        for (let i = 1; i < 3; i++) {
        assert.ok(Math.abs(historyNav.expanded[i].top - layout.navButtons[i].top) < 1, 'message target stays at the same vertical position');
        assert.ok(Math.abs(historyNav.expanded[i].left - layout.navButtons[i].left) < 1, 'message target stays at the same horizontal position');
        }
        assert.equal(historyNav.expanded[2].disabled, false, 'Next enables in history');
        assert.equal(historyNav.expanded[3].text, '99+', 'the unread badge is the only text on Latest');
        assert.ok(historyNav.expanded[3].glyph > 0.9, 'the expanded control shows its glyph again');
        assert.ok(historyNav.inside, 'the rail stays inside the transcript box');
        for (let i = 0; i < historyNav.expanded.length; i++) {
        const button = historyNav.expanded[i];
        assert.ok(button.hitW >= 28 && button.hitH >= 28, 'every expanded navigation control fills its 28px slot');
        assert.ok(button.hit, 'the painted control is itself clickable');
        assert.ok(button.left >= 0 && button.right <= width, 'unread count fits inside the viewport');
        for (const other of historyNav.expanded.slice(0, i)) {
        assert.ok(button.top >= other.bottom || button.bottom <= other.top
        || button.left >= other.right || button.right <= other.left, 'navigation targets never overlap');
        }
        }
        // Folded, the buttons are dots inside the strip: no two dots share a
        // place, and every dot stays inside the rail's own column.
        for (let i = 0; i < historyNav.folded.length; i++) {
        const dot = historyNav.folded[i];
        assert.ok(dot.width < 8 && dot.height < 8, 'the folded control is a dot');
        assert.equal(dot.glyph, 0, 'the folded control paints no glyph');
        assert.ok(dot.left >= historyNav.navRight - 28 - 0.5 && dot.right <= historyNav.navRight + 0.5,
        `the folded dots stay in the rail's column (dot ${dot.left}-${dot.right}, rail ends ${historyNav.navRight})`);
        for (const other of historyNav.folded.slice(0, i)) {
        assert.ok(dot.top >= other.bottom - 0.5 || dot.bottom <= other.top + 0.5, 'the folded dots never overlap');
        }
        }
        // A second tap at the exact original coordinates must still hit
        // Prev, not Latest. Exercise real hit testing rather than .click().
        const prevPoint = layout.navButtons[1];
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
        // A tap on the folded dots unfolds the rail without running a button,
        // and a tap outside it folds it again.
        await evaluate(`document.querySelector('.chat-view__scroll-nav').dataset.expanded = 'false'`);
        await settle();
        const foldedAt = await evaluate(`(() => {
        const nav = document.querySelector('.chat-view__scroll-nav');
        const r = nav.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: document.querySelector('.chat-view__transcript').scrollTop };
        })()`);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: foldedAt.x, y: foldedAt.y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: foldedAt.x, y: foldedAt.y });
        await settle();
        assert.equal(await evaluate(`document.querySelector('.chat-view__scroll-nav').dataset.expanded`), 'true',
        'a tap on the folded dots unfolds the rail');
        assert.equal(await evaluate(`document.querySelector('.chat-view__transcript').scrollTop`), foldedAt.top,
        'unfolding the rail runs no navigation');
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1,
        x: layout.head.left + 8, y: layout.head.top + 8 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1,
        x: layout.head.left + 8, y: layout.head.top + 8 });
        await settle();
        assert.equal(await evaluate(`document.querySelector('.chat-view__scroll-nav').dataset.expanded`), 'false',
        'a tap outside the rail folds it again');
        await evaluate(`document.querySelector('.chat-view__scroll-nav').dataset.expanded = 'true'`);
        await evaluate(`document.querySelector('.chat-view__jump').focus()`);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        await settle();
        assert.equal(await evaluate(`document.querySelector('.chat-view__scroll-nav').dataset.mode`), 'pinned', 'Latest resumes following replies');
        assert.equal(await evaluate(`document.activeElement.className`), 'chat-view__transcript', 'Latest returns focus to the transcript');
        // Top goes to the start of the transcript, and stays there.
        await evaluate(`document.querySelector('.chat-view__nav-btn--top').click()`);
        await settle();
        assert.equal(await evaluate(`document.querySelector('.chat-view__transcript').scrollTop`), 0,
        'the top control scrolls to the start of the transcript');
        await evaluate(`document.querySelector('.chat-view__jump').click()`);
        await settle();
        // Leave the rail in its resting state for the next viewport pass.
        await evaluate(`document.querySelector('.chat-view__scroll-nav').dataset.expanded = 'false'`);
        await settle();
        if (width >= 48 * fontSize) {
        assert.ok(Math.abs(layout.row.left - layout.head.left) < 1, 'transcript stays centred even with a scrollbar');
        // The rail is flush with the transcript's right edge (the chat's
        // right edge), over the scrollbar lane: it covers only a short stretch
        // of a thin bar, which is the deliberate trade for a rail that is not
        // visibly off the side.
        assert.ok(Math.abs(layout.nav.right - layout.transcript.right) < 1,
        `navigation sits flush with the chat's right edge (transcript ends ${layout.transcript.right}, nav ${layout.nav.left}-${layout.nav.right})`);
        assert.ok(layout.preview, 'web preview rendered');
        assert.ok(layout.preview.right <= layout.composer.right, 'preview stays above the composer, not at the frame edge');
        }
        // Nothing is reserved for the rail. Measured as geometry, not by
        // toggling the rail's display: hiding it used to leave the rows
        // exactly where they were, so that check could never fail.
        const railClosed = historyNav.expanded[1].left;
        assert.ok(historyNav.badgeLeft >= railClosed - 0.5,
        `the rail's badge stays inside its column at ${width}px / ${fontSize}px (badge at ${historyNav.badgeLeft}px, `
        + `column starts at ${railClosed}px), so the covered corner never widens`);
        assert.ok(Math.abs(historyNav.badgeLeft - railClosed) < 6,
        `the badge sits on the pill's corner, not beside the rail (badge at ${historyNav.badgeLeft}px, column at ${railClosed}px)`);
        // The rows must still reach the reading column exactly. As an upper
        // bound this assertion could never fail — the whole point is that the
        // rows are no longer shortened to leave the rail a strip.
        const readingColumnRight = Math.min(layout.head.right, historyNav.scrollbarLeft - 8);
        assert.ok(historyNav.rowsRight >= readingColumnRight - 1,
        `rows reach the reading column at ${width}px / ${fontSize}px (row ends at ${historyNav.rowsRight}px, `
        + `column ends at ${readingColumnRight}px — the rail reserves no strip)`);
        // The rail sits over the transcript's right edge at mid-height: that
        // is the deliberate trade. It must therefore stay a small, one-column
        // cluster — never a full-width bar, and never taller than its four
        // slots — and it must leave the row's text measure intact.
        assert.ok(Math.abs(historyNav.expanded[0].left - historyNav.expanded[1].left) < 1
          && Math.abs(historyNav.expanded[3].left - historyNav.expanded[0].left) < 1,
          'the rail stays one column wide, so it covers a strip and not a band');
        assert.ok(historyNav.expanded.every(button => button.right <= layout.transcript.right + 0.5),
        'navigation stays inside the transcript');
        // The bar is still draggable above and below the rail, which covers
        // only a short stretch at mid-height — never its whole length.
        if (historyNav.scrollbarLane > 0) {
        const onBar = await evaluate(`(() => {
        const t = document.querySelector('.chat-view__transcript');
        const r = t.getBoundingClientRect();
        const lane = t.offsetWidth - t.clientWidth - t.clientLeft;
        const x = r.right - lane / 2;
        const ny = r.top + r.height * 0.35;
        const hit = y => { const el = document.elementFromPoint(x, y);
          return el ? (el.closest('.chat-view__nav-btn') ? 'nav-btn' : el === el.closest('.chat-view__scroll-nav') ? 'rail' : el.className || el.tagName) : null; };
        return { x, above: hit(r.top + 8), below: hit(r.bottom - 8), atRail: hit(ny) };
        })()`);
        assert.ok(!String(onBar.above).includes('nav-btn') && !String(onBar.above).includes('rail'),
        `the scrollbar stays draggable above the rail at ${width}px (elementFromPoint at x=${onBar.x} hit ${onBar.above})`);
        assert.ok(!String(onBar.below).includes('nav-btn') && !String(onBar.below).includes('rail'),
        `the scrollbar stays draggable below the rail at ${width}px (elementFromPoint at x=${onBar.x} hit ${onBar.below})`);
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
