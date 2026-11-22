'use strict';
// Capture the Inspector screenshots in docs/features/images/inspector/.
//
//   node scripts/capture-inspector-shots.js [--only a.png,b.png] [--keep]
//
// The Inspector feature pages embed phone-width PNGs of the edit sheet, the
// value rail, the Intent diff and the console. They used to be taken by hand
// against a one-off fixture page; this script rebuilds that page and drives
// the real UI for every frame, so the images can be re-shot in one command.
//
//   1. a throwaway MOUAIF_HOME in the OS temp dir (never the developer's own),
//      with the landing fixture's project, providers and models;
//   2. the "Inspector value fixture" page (FIXTURE_HTML below) on its own
//      static server: a 4 px spacing scale, a palette with one low-contrast
//      ink, header / footer siblings for font-size, and `.card` rows the
//      console expression counts;
//   3. a headless Chrome with --remote-debugging-port that is both the
//      capture browser and the target the Inspector attaches to;
//   4. the app server on an ephemeral port.
//
// Each shot is a fresh app tab at 360 x 740 CSS px (the console one at
// 430 x 640): attach the Inspector to the fixture, pick an element through the
// Styles panel's selector field, open the property's edit sheet, and set the
// state the page documents.
//
// One Inspector image is not taken here: `intent-360.png` shows the Intent
// surface, which is switched off in the app (INTENT_SURFACE in
// Inspector.jsx), so there is no UI to shoot until it comes back.
//
// Requires Chrome. Set CHROME_PATH to override the detected binary.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs/features/images/inspector');
const {
  findChrome, createCdp, waitForFile, freePort,
  writeFixtureProject, gitInit, listenFixtureUpstream
} = require(path.join(ROOT, 'scripts/lib/capture-fixture.js'));

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const onlyAt = argv.indexOf('--only');
const ONLY = onlyAt >= 0 ? String(argv[onlyAt + 1] || '').split(',').filter(Boolean) : [];

const VIEWPORT = { width: 360, height: 740 };
let CTX = null;

// ---- the fixture page ---------------------------------------------------
//
// One page with something for every documented state: spacing on a 4 px
// scale (so the rail has page values and a step), a palette whose `--ink`
// fails contrast against the card, header / footer siblings with their own
// font sizes, and three `.card` rows with a data-state for the console.

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inspector value fixture</title>
<style>
  :root {
    --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
    --ink: #2b3a56; --accent: #9cc2ff; --paper: #ffffff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: #10151f; color: #e8edf5;
    font: 15px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  header { font-size: 16px; font-weight: 700; margin-bottom: 4px; color: #ffffff; }
  header h1 { font-size: 20px; margin: 0; }
  .lede { color: #2b3a56; margin: 4px 0 16px; }
  .row { display: flex; gap: var(--space-2); align-items: center; margin-bottom: 16px; }
  .btn { padding: var(--space-2) var(--space-3); border-radius: 6px; font: inherit; font-weight: 600;
    border: 1px solid var(--accent); }
  .btn--primary { background: var(--accent); color: #0b1220; }
  .btn--ghost { background: transparent; color: #9cc2ff; }
  .tag { padding: var(--space-1); font-size: 12px; background: #1d2638; color: #9aa6b8; border-radius: 4px; }
  section { color: #ffffff; }
  .card { background: #1b2332; border-radius: 8px; margin-bottom: 12px; padding: var(--space-2); color: #e8edf5; }
  .scale-a { padding: 12px; color: #9cc2ff; }
  [data-state="done"].scale-a { color: #2b3a56; }
  .scale-b { color: var(--ink); }
  .card p { margin: 0; }
  .card .size { font-size: 18px; }
  footer { font-size: 13px; color: #9aa6b8; margin-top: 16px; }
</style>
</head>
<body>
<header><h1>Inspector value fixture</h1></header>
<p class="lede">Low-contrast text on the page background.</p>
<div class="row">
  <button class="btn btn--primary" type="button">Primary</button>
  <button class="btn btn--ghost" type="button">Ghost</button>
  <span class="tag">tag</span>
</div>
<section class="card scale-a scale-b" data-state="done">
  <p>Scale specimen — 4/8/12/16 px padding, three text colours.</p>
</section>
<section class="card" data-state="done" style="padding: 8px">
  <p>Padding is 8px here, from a 4px scale.</p>
</section>
<section class="card" data-state="open" style="padding: 16px; display: flex; flex-direction: column; gap: 12px; margin: 0 0 12px; max-width: 42rem; border-radius: 12px">
  <p class="size">A larger line at 18px.</p>
</section>
<footer>Fixture footer — 13px.</footer>
</body>
</html>
`;

// ---- main ---------------------------------------------------------------

async function main() {
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.error('[shots] no Chrome found. Set CHROME_PATH to the browser binary.');
    process.exit(2);
  }
  const children = [];
  const servers = [];
  const tempRoot = path.join(os.tmpdir(), 'mouaif-inspector-shots');
  const home = path.join(tempRoot, 'home');
  const projectDir = path.join(tempRoot, 'demo-app');
  const profileDir = path.join(tempRoot, 'chrome-profile');
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });

  const shutdown = async () => {
    for (const server of servers) { try { server.close(); } catch { /* ignore */ } }
    // Wait for Chrome to exit, so its profile is not removed while it is open.
    await Promise.all(children.map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    })));
    if (!KEEP) {
      try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ignore */ }
    } else {
      console.error('[shots] --keep: fixture left at ' + tempRoot);
    }
  };

  try {
    writeFixtureProject(projectDir);
    gitInit(projectDir);
    process.env.MOUAIF_HOME = home;
    process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
    const settings = require(path.join(ROOT, 'src/settings.js'));
    const projects = require(path.join(ROOT, 'src/projects.js'));
    const chats = require(path.join(ROOT, 'src/chats.js'));
    const messages = require(path.join(ROOT, 'src/messages.js'));
    const seed = require(path.join(ROOT, 'scripts/lib/landing-fixture.js'));

    const upstream = await listenFixtureUpstream({ models: seed.MODELS, port: 0 });
    servers.push(upstream.server);
    settings.runMigrations();
    projects.registerProject(projectDir);
    seed.installProviders(settings, {
      'openai-compatible': { baseUrl: upstream.baseUrl, apiKey: 'sk-demo-not-a-real-key' }
    });
    seed.installProjectModels(projectDir);
    seed.seedChats(projectDir, chats, messages);

    const { createServer } = require(path.join(ROOT, 'src/index.js'));
    const server = createServer(0);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const base = 'http://127.0.0.1:' + server.address().port;

    const fixture = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    servers.push(fixture);
    const fixtureUrl = 'http://127.0.0.1:' + fixture.address().port + '/fixture.html';

    const chromePort = await freePort();
    const chromeLog = path.join(tempRoot, 'chrome.log');
    const chrome = spawn(chromeBin, [
      '--headless=new',
      '--remote-debugging-port=' + chromePort,
      '--user-data-dir=' + profileDir,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--disable-dev-shm-usage', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
      'about:blank'
    ], { stdio: ['ignore', fs.openSync(chromeLog, 'a'), fs.openSync(chromeLog, 'a')] });
    children.push(chrome);
    await waitForFile(chromeLog);
    const cdpBase = 'http://127.0.0.1:' + chromePort;
    await waitForCdp(cdpBase);

    await fetch(base + '/api/inspector/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: cdpBase })
    });

    const ctx = { base, cdpBase, fixtureUrl, projectDir };
    CTX = ctx;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const failed = [];
    for (const shot of SHOTS) {
      if (ONLY.length && !ONLY.includes(shot.file)) continue;
      console.error('[shots] capturing ' + shot.file + '…');
      try {
        await captureShot(shot, ctx);
        console.log('wrote docs/features/images/inspector/' + shot.file);
      } catch (err) {
        failed.push(shot.file);
        console.error('[shots] ' + shot.file + ' failed: ' + err.message);
      }
    }
    if (failed.length) throw new Error('not captured: ' + failed.join(', '));
  } finally {
    await shutdown();
  }
}

async function waitForCdp(cdpBase) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(cdpBase + '/json/version');
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('Chrome never opened ' + cdpBase);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---- the shots ----------------------------------------------------------
//
// Each entry: the file, an optional viewport, and a recipe run in the app tab
// after the Inspector has attached to the fixture. A recipe returns a short
// value that is logged, so a step that found nothing is visible in the run.

const SHOTS = [
  {
    // inspector.md: every optional panel on, attached to the fixture.
    file: 'mobile-360-all-on.png',
    recipe: `(async () => {
      await sleep(800);
      document.querySelector('.inspector') && window.scrollTo(0, 0);
      await waitFor(() => !/^http/.test((document.querySelector('.app-header__title, h1, .page-title') || {}).textContent || '') && document.body, 6000);
      return Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 60);
    })()`,
    settle: 2500
  },
  {
    // inspector-value-rail.md: the value rail for a length, on the page's
    // 4 px scale, with the token marks and the step segments.
    file: 'value-rail-360.png',
    panels: ['styles'],
    recipe: `(async () => {
      await selectElement('.scale-a');
      await fullscreenStyles();
      const opened = await openProp('padding-top');
      await typeValue('16px');
      await sleep(500);
      scrollToEl(Q('.inspector__value-editor'), 0);
      return { opened, text: editorText() };
    })()`
  },
  {
    // inspector-value-rail.md: `padding` fanned out into one rail per side.
    file: 'value-fanout-360.png',
    panels: ['styles'],
    recipe: `(async () => {
      await selectElement('section[data-state="open"]');
      await fullscreenStyles();
      const opened = await openProp('padding');
      await typeValue('10px 14px 18px 14px');
      await sleep(600);
      const fan = Q('.inspector__shape--fanout');
      scrollToEl(Q('.inspector__value-editor'), 8);
      return { opened, fanout: !!fan, text: editorText() };
    })()`
  },
  {
    // inspector-value-rail.md (agent notes): an enum property as segments.
    file: 'value-kinds-enum-360.png',
    panels: ['styles'],
    recipe: `(async () => {
      await selectElement('.row');
      await fullscreenStyles();
      const opened = await openProp('display');
      await sleep(500);
      scrollToEl(Q('.inspector__value-editor'), 8);
      return { opened, text: editorText() };
    })()`
  },
  {
    // inspector-value-rail.md (agent notes): hue / saturation / lightness
    // rails for a colour, and the page palette under them.
    file: 'value-colour-rails-360.png',
    panels: ['styles'],
    recipe: `(async () => {
      await selectElement('.scale-a');
      await fullscreenStyles();
      const opened = await openProp('color');
      await typeValue('#9cc2ff');
      await sleep(600);
      scrollToEl(Q('.inspector__value-editor'), 8);
      return { opened, text: editorText() };
    })()`
  },
  {
    // inspector-value-suggestions.md: the palette with a WCAG contrast badge
    // per swatch, against the selected element's background.
    file: 'value-contrast-360.png',
    panels: ['styles'],
    recipe: `(async () => {
      await selectElement('.scale-a');
      await fullscreenStyles();
      const opened = await openProp('color');
      await typeValue('#9cc2ff');
      await sleep(600);
      const palette = Q('.inspector__shape--colour .grp');
      scrollToEl(palette, 150);
      return { opened, palette: palette ? palette.innerText : '' };
    })()`
  },
  {
    // inspector-value-suggestions.md: an off-scale value, the snap hint, the
    // step note, and the page's own values below them.
    file: 'value-snap-contrast-360.png',
    panels: ['styles'],
    recipe: `(async () => {
      await selectElement('.scale-a');
      await fullscreenStyles();
      const opened = await openProp('padding-top');
      await typeValue('14px');
      await sleep(400);
      openDetails(/units, suggestions/i);
      await sleep(500);
      const snap = Q('.inspector__suggest-snap, .inspector__suggest');
      scrollToEl(snap, 70);
      return { opened, snap: snap ? snap.innerText : '', text: editorText() };
    })()`
  },
  {
    // inspector-value-types.md: the value type switch (Length / Percent /
    // Number / Keyword) and the unit control, for a font-size.
    file: 'value-type-switch-360.png',
    panels: ['styles'],
    recipe: `(async () => {
      await selectElement('.size');
      await fullscreenStyles();
      const opened = await openProp('font-size');
      await sleep(400);
      openDetails(/more options/i);
      await sleep(500);
      const sw = Q('.inspector__valueswitch');
      scrollToEl(sw, 60);
      return { opened, sw: !!sw, text: editorText() };
    })()`
  },
  {
    // inspector-non-destructive-editing.md: the scope summary for a pending
    // edit — what will change and what is kept. Taken before Apply: once
    // applied, the open editor's field shows the pre-edit value again.
    file: 'edit-scope-undo-360.png',
    panels: ['styles'],
    recipe: `(async () => {
      await selectElement('.scale-a');
      await fullscreenStyles();
      const opened = await openProp('padding-top');
      await typeValue('24px');
      await sleep(300);
      openDetails(/more options/i);
      await sleep(400);
      const scopeEl = Q('.inspector__scope');
      scrollToBottom(scopeEl);
      return { opened, scope: scopeEl ? scopeEl.innerText : '' };
    })()`
  },
  {
    // inspector-non-destructive-editing.md: the receipt strip listing the
    // session's edits, each with its own undo.
    file: 'receipt-strip-360.png',
    panels: ['styles'],
    recipe: `(async () => {
      await selectElement('.scale-a');
      await fullscreenStyles();
      const done = [];
      for (const [prop, value] of [['padding-top', '24px'], ['border-top-left-radius', '12px'], ['margin-bottom', '16px']]) {
        if (!(await openProp(prop))) { done.push(prop + ':missing'); continue; }
        // The panel re-reads the element after each write; tapping on before
        // that settles can apply the next edit to a stale value.
        await sleep(600);
        await typeValue(value);
        await sleep(500);
        const apply = byText('.inspector__value-editor button', /^apply$/i);
        if (apply) apply.click();
        await sleep(1200);
        const close = byText('.inspector__value-editor button', /^done$/i);
        if (close) close.click();
        await sleep(900);
        done.push(prop);
      }
      const receipt = Q('.inspector__styles .inspector__receipt');
      scrollToEl(receipt, 120);
      return { done, receipt: receipt ? receipt.innerText : '' };
    })()`
  },
  {
    // inspector-styles.md: the section rail with Declared lit, each chip
    // carrying its count, on a 390 px phone.
    file: 'styles-rail-390.png',
    viewport: { width: 390, height: 844 },
    panels: ['styles'],
    recipe: `(async () => {
      await selectElement('section[data-state="open"]');
      await fullscreenStyles();
      await waitFor(() => QA('.inspector__styles-row-main').length > 0, 8000);
      const chip = byText('.inspector__styles-jump-chip', /^declared/i);
      if (chip) chip.click();
      await sleep(900);
      return QA('.inspector__styles-jump-chip').map((c) => c.className + ':' + c.textContent.trim());
    })()`
  },
  {
    // inspector-js-console.md: the console on a 430 px phone, a three-line
    // expression in the editor and the indent button in its strip.
    file: 'js-console-mobile-430.png',
    viewport: { width: 430, height: 640 },
    panels: ['console'],
    recipe: `(async () => {
      const cm = await waitFor('.inspector__panel[data-panel="console"] .cm-content, .cm-content', 8000);
      if (cm) cm.focus();
      return { cm: !!cm };
    })()`,
    // Typed through CDP so CodeMirror sees real input, then run with the
    // strip's Run button; the expression stays in the editor afterwards.
    afterRecipe: async (cdp, evaluate) => {
      const lines = ["const t = [...document.querySelectorAll('.card')]", "  .filter(c => c.dataset.state === 'done');", 't.length'];
      for (let i = 0; i < lines.length; i++) {
        if (i) await evaluate('document.querySelector(".cm-content").focus()');
        await cdp.send('Input.insertText', { text: (i ? '\n' : '') + lines[i] });
      }
      await new Promise((r) => setTimeout(r, 300));
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 };
      await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, key));
      await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, key));
      await new Promise((r) => setTimeout(r, 1200));
      // Running clears the editor; type the expression back so the frame
      // shows both the result and the three-line entry.
      // An empty editor shows its placeholder, so test for that, not the text.
      const empty = await evaluate('!!document.querySelector(".cm-content .cm-placeholder")');
      if (empty) {
        await evaluate('document.querySelector(".cm-content").focus()');
        await cdp.send('Input.insertText', { text: lines.join('\n') });
      }
      await new Promise((r) => setTimeout(r, 300));
      return evaluate(`(() => {
        document.activeElement && document.activeElement.blur();
        return Array.from(document.querySelectorAll('.inspector__console-row, [class*=console] [class*=row]')).map((r) => r.innerText).slice(-3);
      })()`);
    }
  }
];

// ---- in-page helpers ----------------------------------------------------

const PAGE_HELPERS = `
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(selector, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  for (;;) {
    const el = typeof selector === 'function' ? selector() : document.querySelector(selector);
    if (el) return el;
    if (Date.now() > deadline) return null;
    await sleep(120);
  }
}
// The full-screen Styles card is a second panel in a portal (.inspector__fs);
// while it is open, every query goes to it rather than the card behind it.
function scope() { return document.querySelector('.inspector__fs') || document; }
function Q(selector) { return scope().querySelector(selector); }
function QA(selector) { return Array.from(scope().querySelectorAll(selector)); }
function byText(selector, re) {
  return QA(selector).find((el) => re.test((el.textContent || '').trim())) || null;
}
function setValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
// attachInspector — connect to the fixture tab from the discovered target
// list, the way a user picks an open tab, so the header and status carry the
// page's own title.
async function attachInspector() {
  const name = '[aria-label="Connect to Inspector value fixture"]';
  let row = await waitFor(name, 4000);
  if (!row) {
    const discover = byText('button', /save & discover|refresh targets/i);
    if (discover) discover.click();
    row = await waitFor(name, 10000);
  }
  if (!row) return false;
  row.click();
  return !!(await waitFor('.inspector__panels', 20000));
}
async function selectElement(selector) {
  const field = await waitFor('.inspector__styles-sel', 10000);
  if (!field) return false;
  setValue(field, selector);
  await sleep(80);
  const go = document.querySelector('.inspector__styles-sel-go');
  if (go) go.click();
  await sleep(1200);
  return !document.querySelector('.inspector__styles-sel');
}
// openProp — tap the Styles row for a property (any section that lists it),
// which opens the inline value editor on that row.
async function openProp(prop) {
  const find = () => QA('.inspector__styles-row-main').find((r) => {
    const name = r.querySelector('.inspector__styles-prop');
    return name && name.textContent.trim().replace(/:$/, '') === prop;
  });
  // The full-screen card remounts the panel, which re-reads the element before
  // its rows exist.
  const row = await waitFor(find, 8000);
  if (!row) return 'no row; ' + QA('.inspector__styles-row-main').length + ' rows';
  row.click();
  return !!(await waitFor(() => Q('.inspector__value-editor'), 6000));
}
// typeValue — write a value into the open editor's field, the way typing does.
async function typeValue(value) {
  const field = Q('#inspector-edit-value');
  if (!field) return false;
  field.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);
  return field.value;
}
// fullscreenStyles — open the Styles card full screen, so the editor has the
// phone's height instead of a share of the stacked panels.
async function fullscreenStyles() {
  const btn = document.querySelector('[aria-label="Open Styles full screen"]');
  if (btn) btn.click();
  await sleep(500);
  return !!btn;
}
// openDetails — unfold one of the editor's <details> sections by its summary.
function openDetails(re) {
  const d = QA('.inspector__value-editor details')
    .find((el) => re.test((el.querySelector('summary') || {}).textContent || ''));
  if (d) d.open = true;
  return !!d;
}
function editorText() {
  const ed = Q('.inspector__value-editor');
  return ed ? ed.innerText.slice(0, 600) : '';
}
// scrollToBottom — scroll el's nearest scroller so el ends at its bottom edge.
function scrollToBottom(el) {
  if (!el) return;
  let p = el.parentElement;
  while (p && p !== document.body) {
    const cs = getComputedStyle(p);
    if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight) break;
    p = p.parentElement;
  }
  if (!p || p === document.body) return;
  p.scrollTop += el.getBoundingClientRect().bottom - (p.getBoundingClientRect().bottom - 16);
}
// scrollToEl — bring el to the top of its nearest scroller, below whatever is
// pinned there (the Styles panel's sticky element bar and section rail), plus
// \`offset\` px of the content above it.
function scrollToEl(el, offset) {
  if (!el) return;
  let p = el.parentElement;
  while (p && p !== document.body) {
    const cs = getComputedStyle(p);
    if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight) break;
    p = p.parentElement;
  }
  if (!p || p === document.body) return;
  const top = p.getBoundingClientRect().top;
  let pinned = top;
  for (const child of p.querySelectorAll('*')) {
    if (getComputedStyle(child).position !== 'sticky' || child.contains(el)) continue;
    const r = child.getBoundingClientRect();
    if (r.height && r.top < top + 200) pinned = Math.max(pinned, r.bottom);
  }
  p.scrollTop += el.getBoundingClientRect().top - pinned - 8 - (offset || 0);
}
`;

// waitForApp — poll until the tab has left about:blank and finished loading.
// Polling rather than a load event, so a fast navigation cannot be missed.
async function waitForApp(cdp, base) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `location.href.startsWith(${JSON.stringify(base)}) && document.readyState === 'complete'`,
      returnByValue: true
    }, 5000).catch(() => null);
    if (r && r.result && r.result.value) return;
    if (Date.now() > deadline) throw new Error('the app never loaded');
    await new Promise((res) => setTimeout(res, 150));
  }
}

async function captureShot(shot, ctx) {
  const viewport = shot.viewport || VIEWPORT;
  // A fresh fixture tab per shot: the edit shots write inline styles, and the
  // next shot must start from the page as served.
  const page = await (await fetch(`${ctx.cdpBase}/json/new?${ctx.fixtureUrl}`, { method: 'PUT' })).json();
  await new Promise((r) => setTimeout(r, 1200));
  try {
    await captureInApp(shot, ctx, viewport);
  } finally {
    await fetch(`${ctx.cdpBase}/json/close/${page.id}`).catch(() => { /* ignore */ });
  }
}

async function captureInApp(shot, ctx, viewport) {
  const target = await (await fetch(`${ctx.cdpBase}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = await createCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, configuration: 'mobile' });
    // No blinking text caret in a still frame.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style');`
        + ` st.textContent = '* { caret-color: transparent !important; }'; document.head.appendChild(st); });`
    });
    const panels = shot.panels || ['preview', 'styles', 'console', 'network', 'overview'];
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('mouaif:inspector:panels', ${JSON.stringify(JSON.stringify(panels))}); } catch (e) {}`
    });
    await cdp.send('Page.navigate', { url: ctx.base + '#/inspector' });
    await waitForApp(cdp, ctx.base);
    const expression = PAGE_HELPERS + `(async () => {
      const attached = await attachInspector();
      await sleep(1500);
      const result = await ${shot.recipe};
      return { attached, result };
    })()`;
    const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 60000)
      .catch((err) => ({ error: err.message }));
    const value = out && out.result ? out.result.value : out;
    console.error('[shots] ' + shot.file + ' recipe: ' + JSON.stringify(value).slice(0, 4000));
    if (shot.afterRecipe) {
      const evaluate = async (expr) => {
        const r = await cdp.send('Runtime.evaluate', { expression: PAGE_HELPERS + expr, awaitPromise: true, returnByValue: true }, 20000);
        return r && r.result ? r.result.value : r;
      };
      const after = await shot.afterRecipe(cdp, evaluate).catch((err) => ({ error: err.message }));
      console.error('[shots] ' + shot.file + ' after: ' + JSON.stringify(after).slice(0, 2000));
    }
    await new Promise((r) => setTimeout(r, shot.settle || 900));
    // A headless tab can stop producing frames while it is not the front one;
    // bring it forward and retry once rather than abandon the run.
    let png = null;
    for (let attempt = 0; attempt < 2 && !png; attempt++) {
      await cdp.send('Page.bringToFront').catch(() => { /* ignore */ });
      png = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000)
        .catch((err) => { console.error('[shots] ' + shot.file + ': ' + err.message); return null; });
    }
    if (!png) throw new Error(shot.file + ': no screenshot');
    fs.writeFileSync(path.join(OUT_DIR, shot.file), Buffer.from(png.data, 'base64'));
  } finally {
    cdp.close();
    await fetch(`${ctx.cdpBase}/json/close/${target.id}`).catch(() => { /* ignore */ });
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[shots] ' + (err && err.stack || err));
  process.exit(1);
});
