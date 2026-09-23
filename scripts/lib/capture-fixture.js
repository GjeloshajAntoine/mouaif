'use strict';
// Shared plumbing for the docs screenshot capture scripts.
//
// Two scripts shoot the real UI at a phone viewport and write the PNGs the
// published pages embed:
//
//   scripts/capture-landing-shots.js     -> docs/features/images/landing/
//   scripts/capture-draft-craft-shots.js -> docs/features/images/draft-craft/
//
// Both need the same three things, so they live here instead of being copied:
// a Chrome finder, the tiny CDP client the screenshots go over, and the small
// throwaway project the captures are taken against. Keeping one copy means a
// fixture fix (a Chrome flag, a demo file) lands in both scripts at once.
//
// Nothing here touches the developer's own MOUAIF_HOME: the callers point
// MOUAIF_HOME at a temp dir before requiring any src/ module.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---- Chrome discovery ---------------------------------------------------

// findChrome() -> the browser binary, or null when none is installed.
// CHROME_PATH / CHROME_BIN win so a caller can force a specific build.
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

// ---- CDP plumbing ------------------------------------------------------

// createCdp(wsUrl) -> a minimal client: send(method, params), once(event),
// close(). Deliberately tiny (no dependency): the capture scripts only need
// Page / Runtime / Emulation / Network-free commands.
function createCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.onerror = (err) => reject(err instanceof Error ? err : new Error('websocket error'));
    ws.onopen = () => resolve({
    // A command that never answers must not wedge the capture run: an
    // awaited `Runtime.evaluate` whose execution context is torn down (the
    // page navigates mid-prompt) is dropped by Chrome with no reply, so
    // every send rejects after `timeoutMs` instead of hanging forever.
    send(method, params, timeoutMs = 45000) {
      return new Promise((res, rej) => {
      const msgId = ++id;
      const timer = setTimeout(() => {
        pending.delete(msgId);
        rej(new Error(method + ' timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      pending.set(msgId, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); }
      });
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

// waitForFile(file, timeoutMs) — block until the Chrome log carries its
// "DevTools listening" banner, i.e. the debugging endpoint is up.
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

// ---- Ports -------------------------------------------------------------

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

// ---- The demo project --------------------------------------------------

// writeFixtureProject(dir) — a tiny task-board API with a real source tree,
// an AGENTS.md and a package.json. The captures show this project's files in
// the editor and its chats in the lists, so it is intentionally ordinary and
// short: a two-file src/, one test, and a README that explains the app.
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

// gitInit(dir) — one commit, so the git counts and the file toolbar have
// something real to report. A missing git binary must not fail a capture.
function gitInit(dir) {
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  try {
    run(['init', '-q', '.']);
    run(['add', '-A']);
    run(['-c', 'user.email=shots@mouaif.local', '-c', 'user.name=mouaif shots', 'commit', '-qm', 'feat: task board with a SQLite store']);
  } catch { /* a missing git binary must not fail the capture */ }
}

module.exports = {
  findChrome,
  createCdp,
  waitForFile,
  isPortFree,
  freePort,
  writeFixtureProject,
  gitInit
};
