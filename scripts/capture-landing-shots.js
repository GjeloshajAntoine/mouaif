'use strict';
// Capture the landing-page screenshots in docs/features/images/landing/.
//
//   node scripts/capture-landing-shots.js [--base <url>] [--keep]
//
// The landing page ("See it on a phone" on docs/index.html) shows captures of
// the real UI at a phone viewport. Those PNGs are the page's evidence, so they
// have to be reproducible instead of hand-taken: this script builds all of
// them from scratch in one command.
//
// What it sets up, without touching the machine's own state:
//   1. a throwaway MOUAIF_HOME in the OS temp dir, so the developer's chats,
//      providers and projects are never read or written;
//   2. a small fixture project (source files, AGENTS.md, one git commit) in
//      that home, registered as the only project;
//   3. two project models over three app-level providers, and one seeded chat
//      whose transcript is a real agentic run — a `read_file`, a
//      `search_files`, a `write_file` and a `shell` card, each carrying the
//      JSON shape its tool returns, so the cards render as they do live;
//   4. a headless Chrome with --remote-debugging-port, which is both the
//      capture browser and the target the Inspector tab attaches to in the
//      `inspector` shot;
//   5. the app server on an ephemeral port, serving that home.
//
// Every shot is then a fresh tab: emulated 390 x 700 CSS px at device scale
// factor 2 (a 2x asset that stays sharp on a retina phone), navigate, wait for
// the SPA to settle, optionally run a recipe (scroll position, tapping a
// tab), and screenshot the viewport.
//
// Requires Chrome. Set CHROME_PATH to override the detected binary.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs/features/images/landing');

// ---- args ---------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const KEEP = argv.includes('--keep');
// A caller-supplied base URL skips the throwaway server + fixture boot, which
// is only useful when a human wants to re-shoot one screen against a live app.
const EXTERNAL_BASE = argValue('--base', '');

// ---- chrome discovery ---------------------------------------------------

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* ignore */ }
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf8' }).trim();
      if (found) return found;
    } catch { /* not on PATH */ }
  }
  return null;
}

// ---- fixture project ----------------------------------------------------

function writeFixtureProject(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const files = {
    'AGENTS.md': [
      '# demo-app — agent notes',
      '',
      '- Run `npm test` before every commit; the suite is fast.',
      '- Edit `src/` only — `dist/` is generated.',
      ''
    ].join('\n'),
    'README.md': [
      '# demo-app',
      '',
      'A tiny task-board API. Tasks keep the order they were added in.',
      ''
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'demo-app', version: '1.0.0', private: true, main: 'src/tasks.js',
      scripts: { test: 'node --test' }
    }, null, 2) + '\n',
    'src/tasks.js': [
      "'use strict';",
      '',
      'const tasks = new Map();',
      '',
      'function addTask(title) {',
      '  const id = String(tasks.size + 1);',
      '  tasks.set(id, { id, title, done: false });',
      '  return tasks.get(id);',
      '}',
      '',
      'module.exports = { addTask, tasks };',
      ''
    ].join('\n'),
    'src/store.js': [
      "'use strict';",
      '',
      "const { addTask, tasks } = require('./tasks.js');",
      '',
      'function load(db) {',
      '  const rows = db.prepare(',
      "    'SELECT id, title, done FROM tasks ORDER BY position'",
      '  ).all();',
      '  for (const row of rows) tasks.set(row.id, row);',
      '  return rows;',
      '}',
      '',
      'module.exports = { load, addTask };',
      ''
    ].join('\n'),
    'src/store.test.js': [
      "'use strict';",
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      '',
      "test('ordering after restart matches insertion order', () => {",
      '  assert.equal(1, 1);',
      '});',
      ''
    ].join('\n')
  };
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
}

function gitInit(dir) {
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  try {
    run(['init', '-q', '.']);
    run(['add', '-A']);
    run(['-c', 'user.email=shots@mouaif.local', '-c', 'user.name=mouaif shots', 'commit', '-qm', 'feat: task board with a SQLite store']);
  } catch { /* a missing git binary must not fail the capture */ }
}

// ---- CDP plumbing -------------------------------------------------------

function createCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.onerror = (err) => reject(err instanceof Error ? err : new Error('websocket error'));
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const msgId = ++id;
          pending.set(msgId, { res, rej });
          ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
        });
      },
      once(method, timeoutMs = 45000) {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { listeners.delete(fn); rej(new Error('timeout waiting for ' + method)); }, timeoutMs);
          const fn = (msg) => { clearTimeout(timer); listeners.delete(fn); res(msg.params); };
          listeners.add(fn);
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } }
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const slot = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) slot.rej(new Error(msg.method + ' failed: ' + JSON.stringify(msg.error)));
        else slot.res(msg.result);
        return;
      }
      if (msg.method) for (const fn of listeners) fn(msg);
    };
  });
}

async function waitForFile(file, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('DevTools listening')) return;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Chrome did not report a DevTools endpoint in ' + timeoutMs + 'ms');
}

// isPortFree(port) -> true when nothing is listening on 127.0.0.1:port.
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = require('net').createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

// freePort() -> a port the OS hands us and that we then release.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = require('net').createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ---- the shots ----------------------------------------------------------
//
// Each entry: the hash to open (a string, or a function of the fixture can be
// used as needed), the file to write, and an optional `recipe` evaluated in
// the page before the screenshot (scroll a container, tap a tab). `settle` is
// the extra wait after the SPA's first paint.

const SHOTS = [
  {
    file: 'chats-list.png',
    hash: '#/chats',
    caption: 'Chats',
    alt: 'The Chats tab at 390 px: a project card holding its own chat list and a New chat button under it.'
  },
  {
    file: 'chat-tools.png',
    // A brand-new, message-less chat: its transcript is only the header block
    // (setup control, system prompt, the tools card), so the shot shows the
    // per-tool Off / Ask / Allow controls and the tool checkboxes on their
    // own — the state a user lands in when they open a chat for the first
    // time. The recipe expands every collapsed group so the leaf checkboxes
    // are visible instead of a row of closed sections.
    hash: () => `#/chat/${state.emptyChatId}?projectDir=${encodeURIComponent(state.projectDir)}`,
    alt: 'An empty chat at 390 px: the system-prompt card and the Tools card, listing every tool with a checkbox and an Off / Ask / Allow control, above the "Start the conversation" state.',
    recipe: `(() => {
      for (const chev of document.querySelectorAll('.tool-tree__chev.is-collapsed')) {
        chev.click();
      }
      const t = document.querySelector('.chat-view__transcript');
      if (t) t.scrollTop = 0;
    })()`,
    waitFor: '[data-tools-card="1"]'
  },
  {
    file: 'chat-view.png',
    // The chat shot is taken at the transcript tail, where the run ends. The
    // `.chat-view__transcript` container is where the messages are, so the
    // shot is a real deep link to the real chat, no scrolling trick.
    hash: () => `#/chat/${state.chatId}?projectDir=${encodeURIComponent(state.projectDir)}`,
    alt: 'A chat at 390 px: the model header, an assistant turn with its per-turn cost line, and the Read, Searched, Wrote and Ran tool cards above the composer.',
    recipe: `(() => {
      // Pin to the bottom, which is what the chat itself does on open, so the
      // shot shows the end of the run rather than the top of the transcript.
      const t = document.querySelector('.chat-view__transcript');
      if (t) t.scrollTop = t.scrollHeight;
    })()`
  },
  {
    file: 'inspector.png',
    hash: '#/inspector',
    alt: 'The Inspector at 390 px attached over CDP: the target bar, the panel chips, the live page preview and the interaction class picker.',
    // Type the demo page's URL and let the Inspector open and attach to it —
    // the same path a user takes. The attached page is the debug Chrome we
    // launched, so this needs no other target.
    recipe: `(async () => {
      const input = document.getElementById('inspectorPageUrl');
      if (input) {
        input.value = ${JSON.stringify('PREVIEW_URL')};
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 50));
      const buttons = Array.from(document.querySelectorAll('button'));
      const open = buttons.find((b) => /open & inspect/i.test(b.textContent || ''));
      if (open) open.click();
    })()`,
    settle: 3500,
    waitFor: '.inspector__target-bar, .inspector__preview, .toolbar'
  },
  {
    file: 'settings.png',
    hash: '#/settings',
    alt: 'The Settings tab at 390 px: a Providers section, then the app defaults that apply to every project.'
  },
  {
    file: 'providers.png',
    hash: '#/settings/providers',
    alt: 'Settings → Providers at 390 px: the connected providers, each row naming its endpoint and whether a key is stored.'
  },
  {
    file: 'project-settings.png',
    hash: () => `#/settings/project?projectDir=${encodeURIComponent(state.projectDir)}`,
    alt: 'Project settings at 390 px: prompt style, then the tool list with an Off / Ask / Allow control on every row.'
  }
];

// ---- main ---------------------------------------------------------------

const state = { chatId: '', emptyChatId: '', projectDir: '', previewUrl: '' };

async function main() {
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.error('[shots] no Chrome found. Set CHROME_PATH to the browser binary.');
    process.exit(2);
  }

  const logs = [];
  const children = [];
  const servers = [];
  // A fixed, self-describing root under the OS temp dir. Deliberately *not* a
  // random mkdtemp name: the project path is rendered inside the captures
  // (the Chats card, project settings), so a stable, short path keeps
  // re-captures byte-comparable and keeps a random suffix away from the
  // published page. It is removed before and after every run, so two
  // simultaneous captures would collide — run them one at a time.
  const tempRoot = path.join(os.tmpdir(), 'mouaif-demo');
  const home = path.join(tempRoot, 'home');
  const projectDir = path.join(tempRoot, 'demo-app');
  const profileDir = path.join(tempRoot, 'chrome-profile');
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });

  const shutdown = () => {
    for (const server of servers) {
      try { server.close(); } catch { /* ignore */ }
    }
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    if (!KEEP) {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    } else {
      console.error('[shots] --keep: fixture left at ' + tempRoot);
    }
  };

  let base = EXTERNAL_BASE;
  try {
    if (!base) {
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
      seed.installProviders(settings);
      seed.installProjectModels(projectDir);
      const seeded = seed.seedChats(projectDir, chats, messages);
      state.chatId = seeded.chatId;
      state.emptyChatId = seeded.emptyChatId;
      state.projectDir = projectDir;

      // The app server. `createServer(0)` then listen(0) keeps the port out of
      // the way of any mouaif instance the developer already runs.
      const { createServer } = require(path.join(ROOT, 'src/index.js'));
      const server = createServer(0);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
      base = 'http://127.0.0.1:' + server.address().port;
      logs.push('app on ' + base + ', home ' + home);

      // A static page for the Inspector shot to attach to, served from the
      // fixture project so the captured preview shows real project output.
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
      // Port 3000 first: the Inspector shot shows the URL field, and
      // `http://127.0.0.1:3000/` reads as the ordinary dev-server address
      // rather than an ephemeral one. Fall back to any free port when
      // something on the machine already holds 3000.
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
    }

    // The debug Chrome is both the capture browser and the target the
    // Inspector shot attaches to, so its port has to be a real, reachable
    // devtools endpoint. 9222 is the port the app itself defaults to (and the
    // one the Inspector's own docs name), so prefer it: the shot then shows
    // the ordinary `http://127.0.0.1:9222` URL. When something on the machine
    // already holds 9222, fall back to a free port rather than fighting it —
    // the Inspector shot follows whatever we actually launched.
    const portFree = await isPortFree(9222);
    const chromePort = portFree ? 9222 : await freePort();
    const chromeLog = path.join(tempRoot, 'chrome.log');
    const chrome = spawn(chromeBin, [
      '--headless=new',
      '--remote-debugging-port=' + chromePort,
      '--user-data-dir=' + profileDir,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--hide-scrollbars', '--force-device-scale-factor=1',
      '--window-size=390,700',
      'about:blank'
    ], { stdio: ['ignore', fs.openSync(chromeLog, 'a'), fs.openSync(chromeLog, 'a')] });
    children.push(chrome);
    await waitForFile(chromeLog);
    const cdpBase = 'http://127.0.0.1:' + chromePort;

    // Point the Inspector tab at the debug Chrome we just started, so its
    // setup form is filled in for the `inspector` shot.
    await fetch(base + '/api/inspector/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: cdpBase })
    }).catch(() => { /* the field can also be typed by hand */ });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const shot of SHOTS) {
      const file = path.join(OUT_DIR, shot.file);
      await captureShot({ shot, base, cdpBase });
      logs.push('wrote ' + path.relative(ROOT, file));
    }
    console.log(logs.join('\n'));
  } finally {
    shutdown();
  }
}

async function captureShot({ shot, base, cdpBase }) {
  const target = await (await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = await createCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, configuration: 'mobile' });
    // The app's own hash router, so the shot URL is the real deep link.
    const hash = typeof shot.hash === 'function' ? shot.hash() : shot.hash;
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: base + hash });
    await loaded;
    await cdp.send('Runtime.evaluate', {
      expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      awaitPromise: true
    });
    await new Promise((r) => setTimeout(r, 900));
    if (shot.recipe) {
      const expression = shot.recipe.replace('PREVIEW_URL', state.previewUrl);
      await cdp.send('Runtime.evaluate', { expression, awaitPromise: true }).catch(() => { /* best effort */ });
    }
    if (shot.waitFor) {
      const deadline = Date.now() + 20000;
      for (;;) {
        const found = await cdp.send('Runtime.evaluate', {
          expression: `!!document.querySelector(${JSON.stringify(shot.waitFor)})`,
          returnByValue: true
        }).catch(() => ({ result: { value: false } }));
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