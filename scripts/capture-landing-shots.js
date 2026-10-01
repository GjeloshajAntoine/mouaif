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
//   3. two project models over seven app-level providers, a second project, and one seeded chat
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
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs/features/images/landing');
// Shared with scripts/capture-draft-craft-shots.js: the Chrome finder, the
// CDP client, and the throwaway demo project both capture scripts shoot.
const {
  findChrome, createCdp, waitForFile, isPortFree, freePort,
  writeFixtureProject, gitInit, listenFixtureUpstream
} = require(path.join(ROOT, 'scripts/lib/capture-fixture.js'));

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

// ---- the shots ----------------------------------------------------------
//
// Each entry: the hash to open (a string, or a function of the fixture can be
// used as needed), the file to write, and an optional `recipe` evaluated in
// the page before the screenshot (scroll a container, tap a tab). `settle` is
// the extra wait after the SPA's first paint. A shot may also carry `before` /
// `after` hooks that run in the capture process (state-to-seed, server-side
// setup) around its own capture, so a shot that needs a paused run can park
// one and tear it down without leaking into the next frame.

const SHOTS = [
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
    file: 'subagent-auth.png',
    // The subagent approval card: a live run paused on a `subagent` call, so
    // the transcript's pending-auth poll mounts the authorization card with
    // its per-run model + thinking pickers. `before` parks the call on the
    // real gate and flags the chat as running — the exact state a live run
    // waits in — and `after` answers it so the later `chat-view` shot sees an
    // ordinary settled run instead of a paused one.
    hash: () => `#/chat/${state.chatId}?projectDir=${encodeURIComponent(state.projectDir)}`,
    alt: 'A subagent authorization card at 390 px: the delegated task, the per-run model picker and thinking select, and the Allow once / Allow session / Always allow / Deny buttons.',
    before: () => {
      state.subagentAuth = require('./lib/landing-fixture.js')
        .seedSubagentAuthorization(state.projectDir, state.chatId);
    },
    after: () => {
      const seeded = state.subagentAuth;
      if (!seeded) return;
      require('./lib/landing-fixture.js')
        .clearSubagentAuthorization(state.projectDir, state.chatId, seeded.callId);
      state.subagentAuth = null;
    },
    // The card scrolls itself into view once mounted; give the pending poll
    // its second to run and the scroll to settle before the shot.
    waitFor: '.tool-card--authorization .auth-model-picker',
    settle: 1800
  },
  {
    file: 'chats-list.png',
    hash: '#/chats',
    caption: 'Chats',
    alt: 'The Chats tab at 390 px: a project card holding its own chat list and a New chat button under it.'
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
      if (!t) return;
      t.scrollTop = t.scrollHeight;
      // Then back up to the top of the first message that is cut off at the
      // top edge, so no bubble or role label is sliced in half.
      const top = t.getBoundingClientRect().top;
      const cut = Array.from(t.querySelectorAll('.chat-msg')).find((m) => {
        const r = m.getBoundingClientRect();
        return r.top < top && r.bottom > top;
      });
      if (cut) t.scrollTop -= top - cut.getBoundingClientRect().top + 8;
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
    file: 'providers.png',
    hash: '#/settings/providers',
    alt: 'Settings → Providers at 390 px: the connected providers, each row naming its endpoint and whether a key is stored.'
  },
  {
    // The Dictate page (`Settings → App defaults → Dictation`, `#/dictation`).
    // duration of this frame and `after` restores the seven: the catalog read
    // is live, so with the other six connections in place the page would print
    // one "No models from …" line per unreachable provider — true on the
    // capture machine, but noise on the landing page, and this shot is about
    // the page, not about a machine that cannot reach Google.
    file: 'dictation.png',
    hash: '#/dictation',
    alt: 'The Dictate page at 390 px: the model picker with its request-shape summary, the record button with the timer and level meter, and the transcript with its Copy, Insert and Send actions.',
    before: () => {
    // Skipped against an external `--base` instance, which has no fixture
    // stub: the shot then shows whatever that instance is connected to.
    if (!state.idleProvider) return;
    const settings = require('../src/settings.js');
    state.providersBefore = settings.getApp().providers || [];
    settings.setApp({ providers: [state.idleProvider] });
    },
    after: () => {
    if (!state.idleProvider) return;
    const settings = require('../src/settings.js');
    settings.setApp({ providers: state.providersBefore || [] });
    },
    // The record button is the page's primary control and sits below the
    // model card, so the frame is the recorder rather than the picker alone.
    recipe: `(() => {
      const recorder = document.querySelector('.dictation__card--recorder');
      if (recorder) recorder.scrollIntoView({ block: 'center' });
    })()`,
    // The model list is fetched asynchronously; hold the frame until the
    // picker has rendered its rows so the shot is not an empty shell.
    waitFor: '.dictation__field--route'
  },
  {
    // The phone terminal: a real persistent shell session in the project
    // directory, driven from a phone keyboard that has no Escape, Tab, arrow
    // or Ctrl key — the sheet carries those as two rows of buttons, plus a
    // suggestion row built from the session's own commands and the project's
    // top-level names. This is the capability nothing else in the field has on
    // a phone, so it is worth a section of its own.
    file: 'terminal.png',
    hash: () => `#/chat/${state.chatId}?projectDir=${encodeURIComponent(state.projectDir)}`,
    // The session is a real child process; the recipe types a command, runs
    // it, and waits for its output to arrive over SSE.
    recipe: `(async () => {
    const waitFor = (selector, timeoutMs) => new Promise((resolve) => {
      const deadline = Date.now() + (timeoutMs || 8000);
      const tick = () => {
      if (document.querySelector(selector)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 120);
      };
      tick();
    });
    const trigger = document.querySelector('.file-toolbar__trigger');
    if (trigger) trigger.click();
    await waitFor('.file-toolbar__menu-item', 5000);
    // A menu row's text includes its icon glyph ("🖥Cli"), so match the
    // trailing label span instead of the row's whole textContent.
    const label = (b) => {
    const spans = b.querySelectorAll('span');
    return (spans[spans.length - 1] ? spans[spans.length - 1].textContent : b.textContent || '').trim();
    };
    const cli = Array.from(document.querySelectorAll('.file-toolbar__menu-item'))
    .find((b) => /^cli$/i.test(label(b)));
    if (cli) cli.click();
    await waitFor('.cli__prompt', 15000);
    await new Promise((r) => setTimeout(r, 900));
    const input = document.querySelector('.cli__prompt');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'npm test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 2500));
    const out = document.querySelector('.cli__out');
    if (out) out.scrollTop = out.scrollHeight;
    })()`,
    waitFor: '.cli__keys',
    settle: 1200
  },
  {
    // Git on a phone: the branch, the ahead/behind counts against the remote,
    // Stash / staged / unstaged sections with per-file Stage and Unstage, and
    // the commit bar — the whole working-tree loop without a desktop git
    // client. `before` leaves the fixture with one staged and one unstaged
    // change so the sheet shows the state a user opens it on.
    file: 'git.png',
    hash: () => `#/chat/${state.chatId}?projectDir=${encodeURIComponent(state.projectDir)}`,
    before: () => {
      if (!state.projectDir) return;
      require('./lib/landing-fixture.js').makeGitDirty(state.projectDir);
    },
    recipe: `(async () => {
    const waitFor = (selector, timeoutMs) => new Promise((resolve) => {
      const deadline = Date.now() + (timeoutMs || 8000);
      const tick = () => {
      if (document.querySelector(selector)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 120);
      };
      tick();
    });
    const trigger = document.querySelector('.file-toolbar__trigger');
      if (trigger) trigger.click();
      await waitFor('.file-toolbar__menu-item', 5000);
      const label = (b) => {
      const spans = b.querySelectorAll('span');
      return (spans[spans.length - 1] ? spans[spans.length - 1].textContent : b.textContent || '').trim();
      };
      const git = Array.from(document.querySelectorAll('.file-toolbar__menu-item'))
      .find((b) => /^git$/i.test(label(b)));
      if (git) git.click();
      await waitFor('.gm__sheet', 10000);
      // Wait for the real status to land: the staged file arrives with it.
      await waitFor('.gm__commit-bar', 10000);
      await new Promise((r) => setTimeout(r, 900));
      const body = document.querySelector('.gm__body');
      if (body) body.scrollTop = 0;
    })()`,
    waitFor: '.gm__commit-bar',
    settle: 1500
  },
  {
    // Draft Craft: the annotator over an image attached to a chat draft, with
    // a pen stroke and a labeled pin. This is the surface that makes the app
    // different from every chat wrapper: what usually gets described in prose
    // ("the header wraps on a phone") gets drawn, pinned and attached to the
    // draft without sending it. `before` seeds the draft attachment the chat
    // opens with, so the frame needs no file picker.
    file: 'draft-craft.png',
    hash: () => `#/chat/${state.emptyChatId}?projectDir=${encodeURIComponent(state.projectDir)}`,
    before: async () => {
      if (!state.projectDir) return;
      // A capture of the fixture's own preview page, taken through the same
      // debug Chrome, so the annotation sits over real app pixels.
      state.attachedImage = state.attachedImage || await capturePreviewDataUrl();
      await fetch(state.base + '/api/chats/' + encodeURIComponent(state.emptyChatId), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectDir: state.projectDir,
          draftAttachments: [{
            type: 'image',
            mimeType: 'image/png',
            name: 'board.png',
            dataUrl: state.attachedImage
          }]
        })
      });
    },
    waitFor: '.chat-view__image-chipimg',
    settle: 800,
    recipe: `(async () => {
      const waitFor = (selector, timeoutMs) => new Promise((resolve) => {
        const deadline = Date.now() + (timeoutMs || 8000);
        const tick = () => {
          if (document.querySelector(selector)) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(tick, 120);
        };
        tick();
      });
      const pointer = (el, type, x, y, extra) => el.dispatchEvent(new PointerEvent(type,
        Object.assign({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }, extra || {})));
      const chip = document.querySelector('.chat-view__image-chipimg');
      if (chip) chip.click();
      await waitFor('.draft-craft__canvas-wrap', 10000);
      await new Promise((r) => setTimeout(r, 600));
      // One pen stroke.
      const canvas = document.querySelector('.draft-craft__canvas');
      const box = canvas.getBoundingClientRect();
      const pts = [[0.18, 0.42], [0.36, 0.30], [0.56, 0.46], [0.78, 0.32]];
      const at = (p) => ({ x: box.left + box.width * p[0], y: box.top + box.height * p[1] });
      const first = at(pts[0]);
      pointer(canvas, 'pointerdown', first.x, first.y);
      for (const p of pts.slice(1)) { const q = at(p); pointer(canvas, 'pointermove', q.x, q.y); }
      const last = at(pts[pts.length - 1]);
      pointer(canvas, 'pointerup', last.x, last.y, { buttons: 0 });
      // One labeled pin, dragged from its source onto the canvas.
      const source = document.querySelector('.draft-craft__marker-source');
      const stage = document.querySelector('.draft-craft__canvas-stage');
      if (source && stage) {
        const sr = source.getBoundingClientRect();
        const sx = sr.left + sr.width / 2;
        const sy = sr.top + sr.height / 2;
        const tr = stage.getBoundingClientRect();
        const dx = tr.left + tr.width * 0.5;
        const dy = tr.top + tr.height * 0.62;
        pointer(source, 'pointerdown', sx, sy);
        pointer(source, 'pointermove', dx, dy);
        pointer(source, 'pointerup', dx, dy, { buttons: 0 });
        await new Promise((r) => setTimeout(r, 350));
        const input = document.querySelector('.draft-craft__marker-input');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, 'Header wraps here');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    })()`,
    waitFor: '.draft-craft__marker-input'
  }
];

// ---- main ---------------------------------------------------------------

const state = { chatId: '', emptyChatId: '', projectDir: '', previewUrl: '', base: '', cdpBase: '', attachedImage: '', subagentAuth: null, providersBefore: null, idleProvider: null };

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

      // The OpenAI-compatible connection's endpoint. Started before the app
      // server so the connection stores its real origin in one pass, and before
      // any module reads the fixture's model records. Port 8081 first: the
      // provider row renders this URL in the captures, and a stable port keeps
      // a re-capture comparable (an ephemeral one is used if 8081 is taken).
      const upstream = await listenFixtureUpstream({
      models: require(path.join(ROOT, 'scripts/lib/landing-fixture.js')).MODELS,
      port: 8081
      });
      servers.push(upstream.server);
      logs.push('fixture upstream on ' + upstream.baseUrl);

      const settings = require(path.join(ROOT, 'src/settings.js'));
      const projects = require(path.join(ROOT, 'src/projects.js'));
      const chats = require(path.join(ROOT, 'src/chats.js'));
      const messages = require(path.join(ROOT, 'src/messages.js'));
      const seed = require(path.join(ROOT, 'scripts/lib/landing-fixture.js'));

      settings.runMigrations();
      projects.registerProject(projectDir);
      // A second, smaller project so the Chats tab shows the project-card
      // grouping instead of one card over an empty screen.
      const secondDir = path.join(tempRoot, 'api-server');
      fs.mkdirSync(secondDir, { recursive: true });
      fs.writeFileSync(path.join(secondDir, 'README.md'), '# api-server\n');
      projects.registerProject(secondDir);
      seed.seedSecondProject(secondDir, chats);
      seed.installProviders(settings, {
      // The fixture's models run on an OpenAI-compatible connection pointed
      // at this stub, so the chat head's Balance chip is a real answer from a
      // local server instead of a live billing call to a third party.
      // See listenFixtureUpstream in scripts/lib/capture-fixture.js.
      'openai-compatible': { baseUrl: upstream.baseUrl, apiKey: 'sk-demo-not-a-real-key' }
      });
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

      // The one connection the Dictate shot keeps (see its `before` hook): the
      // fixture's own stub, which answers the local `/v1/models` the page reads
      // for live rows. Built here from the stub's real URL so the frame shows a
      // reachable connection instead of six upstream errors.
      const providersAfterSeed = settings.getApp().providers || [];
      state.idleProvider = Object.assign(
      {},
      providersAfterSeed.find((p) => p && p.id === 'openai-compatible') || { id: 'openai-compatible' },
      { baseUrl: upstream.baseUrl, apiKey: 'sk-demo-not-a-real-key' }
      );
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
    state.base = base;
    state.cdpBase = cdpBase;

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
    if (typeof shot.before === 'function') await shot.before();
    try {
      await captureShot({ shot, base, cdpBase });
    } finally {
      if (typeof shot.after === 'function') shot.after();
    }
    logs.push('wrote ' + path.relative(ROOT, file));
    }
    console.log(logs.join('\n'));
  } finally {
    shutdown();
  }
}

// capturePreviewDataUrl() — open the fixture's preview page and return a PNG
// data URL of it. Used as the image the Draft Craft shot annotates, so the
// pins sit over the demo project's real output instead of a mock. Runs in the
// already-launched debug Chrome.
async function capturePreviewDataUrl() {
  const target = await (await fetch(`${state.cdpBase}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = await createCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: state.previewUrl });
    await loaded;
    await new Promise((r) => setTimeout(r, 900));
    const png = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return 'data:image/png;base64,' + png.data;
  } finally {
    cdp.close();
    await fetch(`${state.cdpBase}/json/close/${target.id}`).catch(() => { /* ignore */ });
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