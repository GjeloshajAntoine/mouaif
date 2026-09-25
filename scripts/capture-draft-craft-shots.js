'use strict';
// Capture the Draft Craft screenshots in docs/features/images/draft-craft/.
//
//   node scripts/capture-draft-craft-shots.js [--keep]
//
// The published guide (docs/features/draft-craft.md) embeds one PNG per step,
// and those PNGs have to be the real UI or they quietly become fiction. This
// script takes all six from a running app in one command:
//
//   1. a throwaway MOUAIF_HOME in the OS temp dir (never the developer's own);
//   2. the demo task-board project, two projects on the Chats tab, seven
//      providers, two project models and one seeded run, all from
//      scripts/lib/landing-fixture.js;
//   3. a headless Chrome with --remote-debugging-port that is both the
//      capture browser and the target the Inspector attaches to;
//   4. the app server on an ephemeral port, plus the fixture web page the
//      Inspector shot debugs.
//
// The images are shot at 360 x 780 CSS px (a phone viewport, the width the
// published page documents). Two of the shots show an image *attached* to a
// chat: that attachment is itself a capture of the app's Chats tab, taken
// first, so the annotation sits over real app pixels rather than a mock.
//
// Requires Chrome. Set CHROME_PATH to override the detected binary.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs/features/images/draft-craft');
const {
  findChrome, createCdp, waitForFile, isPortFree, freePort,
  writeFixtureProject, gitInit
} = require(path.join(ROOT, 'scripts/lib/capture-fixture.js'));

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');

const VIEWPORT = { width: 360, height: 780 };

// state is filled in by main() before any shot runs: the two chat deep links,
// the project dir, the Inspector's preview URL, and the data URL of the
// screenshot used as the chat's attached image.
const state = { chatId: '', emptyChatId: '', projectDir: '', previewUrl: '', attachedImage: '' };

// ---- the shots ----------------------------------------------------------
//
// Each entry is a fresh tab: emulate the phone viewport, navigate to the hash,
// settle, run the recipe (which drives real taps / pointer events in the
// page), then screenshot. `waitFor` is a selector that must exist before the
// wait is over, so a slow capture loop or image decode cannot photograph a
// half-painted sheet.

const SHOTS = [
  {
    // Path A, step 1: the attached image sitting in the composer as a chip,
    // above the text field, in a chat with nothing sent yet.
    file: 'composer-image-chip-360.png',
    hash: () => `#/chat/${state.emptyChatId}?projectDir=${encodeURIComponent(state.projectDir)}`,
    waitFor: '.chat-view__image-chipimg',
    settle: 900
  },
  {
    // Path A, steps 2-4: the annotator over that attached image. One pen
    // stroke and one labeled dot, tools folded away so the image gets the
    // canvas — exactly the state the "Finish" step describes.
    file: 'annotator-canvas-360.png',
    hash: () => `#/chat/${state.emptyChatId}?projectDir=${encodeURIComponent(state.projectDir)}`,
    waitFor: '.chat-view__image-chipimg',
    settle: 600,
    recipe: `(async () => {
      const chip = document.querySelector('.chat-view__image-chipimg');
      if (chip) chip.click();
      await waitFor('.draft-craft__canvas-wrap', 8000);
      await new Promise((r) => setTimeout(r, 500));
      drawStroke();
      placeMarker('Button is cut off here', 0.5, 0.34);
      const toggle = document.querySelector('.draft-craft__tools-toggle');
      if (toggle) toggle.click();
    })()`
  },
  {
    // The shared annotator with its tools open: the zoom row, the four
    // swatches, and one marker row with its text field.
    file: 'annotator-marker-edit-360.png',
    hash: () => `#/chat/${state.emptyChatId}?projectDir=${encodeURIComponent(state.projectDir)}`,
    waitFor: '.chat-view__image-chipimg',
    settle: 600,
    recipe: `(async () => {
      const chip = document.querySelector('.chat-view__image-chipimg');
      if (chip) chip.click();
      await waitFor('.draft-craft__canvas-wrap', 8000);
      await new Promise((r) => setTimeout(r, 500));
      drawStroke();
      placeMarker('Header is misaligned', 0.5, 0.3);
      setNote('The card header wraps on a 360 px phone.');
    })()`
  },
  {
    // Path B, step 2: the Preview panel toolbar with the blue Draft Craft
    // button in the row. The page is attached over CDP, so this is the real
    // toolbar with a real captured frame behind it.
    file: 'inspector-preview-360.png',
    hash: '#/inspector',
    recipe: `(async () => {
      await attachInspector();
      await waitFor('.inspector__panel-draft-craft', 20000);
      await new Promise((r) => setTimeout(r, 1200));
    })()`,
    waitFor: '.inspector__panel-draft-craft',
    settle: 1500
  },
  {
    // Path B, steps 4-5: "Add to chat draft" tapped from the Inspector
    // annotator, with the project + chat picker sheet open over the dimmed
    // annotator.
    file: 'add-to-draft-360.png',
    hash: '#/inspector',
    recipe: `(async () => {
      await attachInspector();
      await waitFor('.inspector__panel-draft-craft', 20000);
      await new Promise((r) => setTimeout(r, 1000));
      const draft = document.querySelector('.inspector__panel-draft-craft');
      if (draft) draft.click();
      await waitFor('.draft-craft__annotator', 8000);
      await new Promise((r) => setTimeout(r, 600));
      drawStroke();
      const add = Array.from(document.querySelectorAll('.draft-craft__annotator-foot button'))
        .find((b) => /add to chat draft/i.test(b.textContent || ''));
      if (add) add.click();
      await waitFor('.draft-craft__sheet', 8000);
    })()`,
    waitFor: '.draft-craft__sheet',
    settle: 1200
  },
  {
    // Path C, step 3: the file editor with code selected and the Draft Craft
    // button in the open file's display bar.
    file: 'file-editor-360.png',
    hash: () => `#/chat/${state.chatId}?projectDir=${encodeURIComponent(state.projectDir)}`,
    settle: 900,
    recipe: `(async () => {
    await openFileEditor();
    await waitFor('.fe__editor-host .cm-content', 10000);
    await new Promise((r) => setTimeout(r, 500));
    clickListRow('src');
    await waitFor('.fe__row[aria-label], .fe__row', 4000);
    await new Promise((r) => setTimeout(r, 700));
    clickListRow('store.js');
    await waitFor('.fe__draft-craft', 10000);
    await new Promise((r) => setTimeout(r, 600));
    selectLines(7, 9);
    })()`,
    waitFor: '.fe__draft-craft'
  }
];

// ---- in-page helpers ----------------------------------------------------
//
// These are stringified into Runtime.evaluate. They are written as plain
// functions (not arrow consts) so a hoisted call inside a recipe resolves
// regardless of declaration order in the injected bundle.

const PAGE_HELPERS = `
function waitFor(selector, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + (timeoutMs || 8000);
    const tick = () => {
      if (document.querySelector(selector)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
}
function pointerEvents(el, type, x, y, extra) {
  const init = Object.assign({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }, extra || {});
  el.dispatchEvent(new PointerEvent(type, init));
}
function drawStroke() {
  const canvas = document.querySelector('.draft-craft__canvas');
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  const pts = [[0.18, 0.62], [0.34, 0.48], [0.52, 0.66], [0.72, 0.5], [0.86, 0.6]];
  const at = (p) => ({ x: r.left + r.width * p[0], y: r.top + r.height * p[1] });
  const first = at(pts[0]);
  pointerEvents(canvas, 'pointerdown', first.x, first.y);
  for (const p of pts.slice(1)) {
    const q = at(p);
    pointerEvents(canvas, 'pointermove', q.x, q.y);
  }
  const last = at(pts[pts.length - 1]);
  pointerEvents(canvas, 'pointerup', last.x, last.y, { buttons: 0 });
}
function placeMarker(text, fx, fy) {
  const source = document.querySelector('.draft-craft__marker-source');
  const stage = document.querySelector('.draft-craft__canvas-stage');
  if (!source || !stage) return;
  const sr = source.getBoundingClientRect();
  const startX = sr.left + sr.width / 2;
  const startY = sr.top + sr.height / 2;
  pointerEvents(source, 'pointerdown', startX, startY);
  const tr = stage.getBoundingClientRect();
  const dropX = tr.left + tr.width * fx;
  const dropY = tr.top + tr.height * fy;
  pointerEvents(source, 'pointermove', dropX, dropY);
  pointerEvents(source, 'pointerup', dropX, dropY, { buttons: 0 });
  if (text) {
    // The row is only rendered once Preact has committed the new marker, so
    // wait a tick — otherwise the field does not exist yet and the typed text
    // is dropped.
    setTimeout(() => {
      const input = document.querySelector('.draft-craft__marker-input');
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, 250);
  }
}
function setNote(value) {
  const note = document.querySelector('.draft-craft__note');
  if (!note) return;
  note.value = value;
  note.dispatchEvent(new Event('input', { bubbles: true }));
}
function openFileEditor() {
  const trigger = document.querySelector('.file-toolbar__trigger');
  if (trigger) trigger.click();
  return new Promise((resolve) => setTimeout(() => {
    const item = Array.from(document.querySelectorAll('.file-toolbar__menu-item'))
      .find((b) => /files/i.test(b.textContent || ''));
    if (item) item.click();
    resolve(true);
  }, 350));
}
function clickListRow(name) {
  const row = Array.from(document.querySelectorAll('.fe__row'))
    .find((r) => (r.querySelector('.fe__row-name') || {}).textContent === name);
  if (row) { row.click(); return true; }
  return false;
}
function selectLines(fromLine, toLine) {
  const content = document.querySelector('.fe__editor-host .cm-content');
  if (!content) return false;
  content.focus();
  const lineHeight = parseFloat(getComputedStyle(content).lineHeight) || 20;
  const box = content.getBoundingClientRect();
  const x = box.left + 26;
  const yFor = (n) => box.top + lineHeight * (n - 0.5);
  const y0 = yFor(fromLine);
  const y1 = yFor(toLine);
  pointerEvents(content, 'pointerdown', x, y0);
  pointerEvents(content, 'pointermove', x, y1);
  pointerEvents(content, 'pointerup', x, y1, { buttons: 0 });
  return true;
}
`;

// attachInspector — type the fixture URL into the Inspector and attach. This
// mirrors what a user does, so the shot shows the real attach path.
const ATTACH_INSPECTOR = `
function attachInspector() {
  return new Promise((resolve) => {
    const input = document.getElementById('inspectorPageUrl');
    if (input) {
      input.value = ${JSON.stringify('__PREVIEW_URL__')};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setTimeout(() => {
      const open = Array.from(document.querySelectorAll('button'))
        .find((b) => /open & inspect/i.test(b.textContent || ''));
      if (open) open.click();
      setTimeout(resolve, 1500);
    }, 60);
  });
}
`;

// ---- main ---------------------------------------------------------------

async function main() {
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.error('[shots] no Chrome found. Set CHROME_PATH to the browser binary.');
    process.exit(2);
  }

  const logs = [];
  const children = [];
  const servers = [];
  const tempRoot = path.join(os.tmpdir(), 'mouaif-draft-craft');
  const home = path.join(tempRoot, 'home');
  const projectDir = path.join(tempRoot, 'demo-app');
  const profileDir = path.join(tempRoot, 'chrome-profile');
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });

  const shutdown = () => {
    for (const server of servers) { try { server.close(); } catch { /* ignore */ } }
    for (const child of children) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
    if (!KEEP) {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
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

    settings.runMigrations();
    projects.registerProject(projectDir);
    const secondDir = path.join(tempRoot, 'api-server');
    fs.mkdirSync(secondDir, { recursive: true });
    fs.writeFileSync(path.join(secondDir, 'README.md'), '# api-server\n');
    projects.registerProject(secondDir);
    seed.seedSecondProject(secondDir, chats);
    seed.installProviders(settings);
    seed.installProjectModels(projectDir);
    const seeded = seed.seedChats(projectDir, chats, messages);
    state.chatId = seeded.chatId;
    state.emptyChatId = seeded.emptyChatId;
    state.projectDir = projectDir;

    const { createServer } = require(path.join(ROOT, 'src/index.js'));
    const server = createServer(0);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const base = 'http://127.0.0.1:' + server.address().port;
    logs.push('app on ' + base + ', home ' + home);

    // The fixture page the Inspector attaches to. Served from the project's
    // public/ dir so the preview shows real project output.
    const staticDir = path.join(projectDir, 'public');
    seed.writePreviewPage(staticDir);
    const staticServer = require('http').createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(staticDir, rel);
      if (!file.startsWith(staticDir)) { res.writeHead(403); res.end('forbidden'); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buf);
      });
    });
    const listenPreview = (port) => new Promise((resolve) => {
      const onError = (err) => {
        if (err && err.code === 'EADDRINUSE' && port !== 0) {
          staticServer.removeListener('error', onError);
          listenPreview(0).then(resolve);
          return;
        }
        throw err;
      };
      staticServer.once('error', onError);
      staticServer.listen(port, '127.0.0.1', () => {
        staticServer.removeListener('error', onError);
        resolve();
      });
    });
    await listenPreview(3000);
    servers.push(staticServer);
    state.previewUrl = 'http://127.0.0.1:' + staticServer.address().port + '/';
    logs.push('preview page on ' + state.previewUrl);

    // The debug Chrome is both the capture browser and the Inspector target.
    const portFree = await isPortFree(9222);
    const chromePort = portFree ? 9222 : await freePort();
    const chromeLog = path.join(tempRoot, 'chrome.log');
    const chrome = spawn(chromeBin, [
      '--headless=new',
      '--remote-debugging-port=' + chromePort,
      '--user-data-dir=' + profileDir,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--hide-scrollbars', '--force-device-scale-factor=1',
      '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
      'about:blank'
    ], { stdio: ['ignore', fs.openSync(chromeLog, 'a'), fs.openSync(chromeLog, 'a')] });
    children.push(chrome);
    await waitForFile(chromeLog);
    const cdpBase = 'http://127.0.0.1:' + chromePort;

    await fetch(base + '/api/inspector/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: cdpBase })
    }).catch(() => { /* the field can also be typed by hand */ });

    // The image the chat attaches in Path A: a real capture of the Chats tab,
    // taken through the same CDP session, so the annotation sits over the app
    // the guide is describing.
    state.attachedImage = await captureChatsDataUrl({ cdpBase, base });
    console.error('[shots] seeded attachment ' + Math.round(state.attachedImage.length / 1024) + ' KB');
    await fetch(base + '/api/chats/' + encodeURIComponent(state.emptyChatId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectDir,
        draftAttachments: [{
          type: 'image',
          mimeType: 'image/png',
          name: 'chats-tab.png',
          dataUrl: state.attachedImage
        }]
      })
    }).then(async (r) => {
      if (!r.ok) throw new Error('could not seed the draft attachment: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const shot of SHOTS) {
    console.error('[shots] capturing ' + shot.file + '…');
    await captureShot({ shot, base, cdpBase });
    logs.push('wrote docs/features/images/draft-craft/' + shot.file);
    }
    console.log(logs.join('\n'));
  } finally {
    shutdown();
  }
}

// captureChatsDataUrl — open the Chats tab, screenshot it, return a PNG data
// URL. Runs in the same debug Chrome, so no extra browser is launched.
async function captureChatsDataUrl({ cdpBase, base }) {
  const target = await (await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = await createCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: true });
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: base + '#/chats' });
    await loaded;
    await new Promise((r) => setTimeout(r, 1600));
    const png = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return 'data:image/png;base64,' + png.data;
  } finally {
    cdp.close();
    await fetch(`${cdpBase}/json/close/${target.id}`).catch(() => { /* ignore */ });
  }
}

async function captureShot({ shot, base, cdpBase }) {
  const target = await (await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = await createCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, configuration: 'mobile' });
    const hash = typeof shot.hash === 'function' ? shot.hash() : shot.hash;
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: base + hash });
    await loaded;
    // A short timer instead of requestAnimationFrame: a headless tab with no
    // compositor can park rAF indefinitely, which would stall the run. The
    // app's own first paint is what matters, and the per-shot settle covers it.
    await cdp.send('Runtime.evaluate', {
    expression: 'new Promise(r => setTimeout(r, 300))',
    awaitPromise: true
    }, 8000).catch(() => { /* a paused tab must not abort the capture */ });
    await new Promise((r) => setTimeout(r, 700));
    if (shot.recipe) {
    const expression = PAGE_HELPERS
      + ATTACH_INSPECTOR.replace('__PREVIEW_URL__', state.previewUrl)
      + shot.recipe;
    // The recipe drives real UI, so it can legitimately wait on the app; a
    // generous but finite budget keeps a stuck step from hanging the run.
    await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 40000)
      .catch((err) => { console.error('[shots] recipe for ' + shot.file + ' failed: ' + err.message); });
    console.error('[shots] recipe for ' + shot.file + ' done');
    }
    await cdp.send('Runtime.evaluate', {
    expression: PAGE_HELPERS + 'new Promise(r => setTimeout(r, 250))',
    awaitPromise: true
    }, 8000).catch(() => { /* a paused tab must not abort the capture */ });
    if (shot.waitFor) {
    const deadline = Date.now() + 20000;
    for (;;) {
      const found = await cdp.send('Runtime.evaluate', {
      expression: `!!document.querySelector(${JSON.stringify(shot.waitFor)})`,
      returnByValue: true
      }, 8000).catch(() => ({ result: { value: false } }));
      if (found && found.result && found.result.value) break;
      if (Date.now() > deadline) throw new Error(shot.file + ': never saw ' + shot.waitFor);
      await new Promise((r) => setTimeout(r, 200));
    }
    }
    await new Promise((r) => setTimeout(r, shot.settle || 700));
    const png = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT_DIR, shot.file), Buffer.from(png.data, 'base64'));
  } finally {
    cdp.close();
    await fetch(`${cdpBase}/json/close/${target.id}`).catch(() => { /* ignore */ });
  }
}

main().then(() => {
  // The app server holds keep-alive timers (SSE / polling), so the loop would
  // otherwise stay alive after the last PNG is written. Every write above is
  // synchronous, so exiting here loses nothing.
  process.exit(0);
}).catch((err) => {
  console.error('[shots] ' + (err && err.stack || err));
  process.exit(1);
});
