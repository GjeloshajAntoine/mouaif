// In-app Back must return to an earlier history entry, never push a new one.
//
// The bug this pins: the chat header ← (and every settings Back arrow, and the
// redirect after a delete/save) set `location.hash` to the target, which
// PUSHED it. History then read `list, chat, list`, so the system Back gesture
// reopened the chat the user had just left — an endless loop between two
// pages. frontend/src/navHistory.js keeps the chain of entries the router has
// seen so `back()` can `history.go(-n)` to the matching entry instead.
//
// Part 1 drives the pure book. Part 2 runs the real router.js against a small
// simulated browser history (entries, state, hashchange, go/replace) and
// replays the reported flows.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL('../frontend/src/' + file, import.meta.url), 'utf8');
const asModule = (text) => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const book = await import(asModule(read('navHistory.js')));
const routes = await import(asModule(read('routes.js')));

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('  ok   - ' + name); }

// ---- Part 1: the pure book -------------------------------------------------

ok('stepsBack counts real steps along the prev chain', () => {
  const b = book.emptyBook();
  const a = book.addEntry(b, '#/projects', null);
  const c = book.addEntry(b, '#/chat/1?projectDir=%2Fp', a);
  const s = book.addEntry(b, '#/settings/project?projectDir=%2Fp&chatId=1', c);
  assert.equal(book.stepsBack(b, s, (h) => h.startsWith('#/chat/')), 1);
  assert.equal(book.stepsBack(b, s, (h) => h === '#/projects'), 2);
  assert.equal(book.stepsBack(b, s, (h) => h === '#/inspector'), 0, 'no match → 0 (caller replaces)');
  assert.equal(book.stepsBack(b, a, () => true), 0, 'the first entry has nothing behind it');
});

ok('a pruned entry ends the chain instead of guessing', () => {
  const b = book.emptyBook();
  let prev = null;
  for (let i = 0; i < book.MAX_ENTRIES + 5; i += 1) prev = book.addEntry(b, '#/n' + i, prev);
  assert.equal(Object.keys(b.entries).length, book.MAX_ENTRIES);
  assert.equal(book.stepsBack(b, prev, (h) => h === '#/n0'), 0);
});

ok('parseBook survives garbage', () => {
  assert.deepEqual(book.parseBook('{nope'), book.emptyBook());
  assert.deepEqual(book.parseBook(''), book.emptyBook());
  assert.deepEqual(book.parseBook('{"seq":"x"}'), book.emptyBook());
});

ok('sameRoute treats #/, #/projects and query order as equal', () => {
  const p = routes.parseHash;
  assert.ok(book.sameRoute(p('#/'), p('#/projects')));
  assert.ok(book.sameRoute(p('#/settings/mcp?projectDir=%2Fp&from=projects'), p('#/settings/mcp?from=projects&projectDir=%2Fp')));
  assert.ok(!book.sameRoute(p('#/chat/1?projectDir=%2Fp'), p('#/chat/2?projectDir=%2Fp')));
});

// ---- Part 2: router.js against a simulated history -------------------------

function makeBrowser(initialHash) {
  const listeners = { hashchange: [], pageshow: [], click: [] };
  const storage = new Map();
  const h = { entries: [{ hash: initialHash, state: null }], index: 0 };
  const fire = () => listeners.hashchange.forEach((fn) => fn({}));
  const cur = () => h.entries[h.index];
  const setHash = (value, replace) => {
    const next = value.startsWith('#') ? value : '#' + value;
    if (next === cur().hash) return;
    if (replace) h.entries[h.index] = { hash: next, state: null };
    else { h.entries.splice(h.index + 1); h.entries.push({ hash: next, state: null }); h.index += 1; }
    fire();
  };
  const location = {
    get hash() { return cur().hash; },
    set hash(v) { setHash(v, false); },
    replace(v) { setHash(v, true); }
  };
  const history = {
    get state() { return cur().state; },
    get length() { return h.entries.length; },
    replaceState(state, _t, url) { cur().state = state; if (url) cur().hash = url; },
    go(n) {
      const to = Math.max(0, Math.min(h.entries.length - 1, h.index + n));
      if (to === h.index) return;
      h.index = to; fire();
    },
    back() { this.go(-1); }
  };
  const win = {
    location, history,
    sessionStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    addEventListener: (t, fn) => (listeners[t] || (listeners[t] = [])).push(fn)
  };
  const doc = { addEventListener: (t, fn) => (listeners[t] || (listeners[t] = [])).push(fn) };
  return { win, doc, h, listeners, hashes: () => h.entries.map((e) => e.hash) };
}

// Load router.js with its imports swapped for the real routes/navHistory and a
// stub `route` signal. The browser globals come from `browser`.
let loadCount = 0;
async function loadRouter(browser) {
  globalThis.window = browser.win;
  globalThis.document = browser.doc;
  const route = { value: null };
  globalThis.__navTestRoute = route;
  const src = read('router.js')
    .replace("import { route } from './api.js';", 'const route = globalThis.__navTestRoute;')
    .replace("from './routes.js';", "from '" + asModule(read('routes.js')) + "';")
    .replace("from './navHistory.js';", "from '" + asModule(read('navHistory.js')) + "';")
    + '\n// load ' + (loadCount += 1);
  const mod = await import(asModule(src));
  return { ...mod, route };
}

const CHAT = 'chat/abc?projectDir=%2Fp';

ok('setup: the simulated browser behaves like hash history', () => {
  const b = makeBrowser('#/projects');
  b.win.location.hash = '#/x';
  b.win.history.back();
  assert.equal(b.win.location.hash, '#/projects');
});

{
  const b = makeBrowser('#/projects');
  const r = await loadRouter(b);
  ok('list → chat → ← returns to the list without pushing', () => {
    r.nav(CHAT);
    assert.equal(r.route.value.name, 'chat');
    r.back('projects');
    assert.equal(b.win.location.hash, '#/projects');
    assert.equal(r.route.value.name, 'chats');
    assert.equal(b.h.index, 0, 'back() popped to the list entry');
    // The system Back gesture from here leaves the app instead of reopening
    // the chat (the old behavior: `list, chat, list` → Back → chat).
    b.win.history.back();
    assert.equal(b.h.index, 0);
    assert.notEqual(b.win.location.hash, '#/' + CHAT);
  });
}

{
  const b = makeBrowser('#/' + CHAT);
  const r = await loadRouter(b);
  ok('deep link / notification tap into a chat: ← replaces, never loops', () => {
    r.back('projects');
    assert.deepEqual(b.hashes(), ['#/projects'], 'the chat entry was replaced by the list');
    assert.equal(r.route.value.name, 'chats');
  });
}

{
  const b = makeBrowser('#/projects');
  const r = await loadRouter(b);
  ok('chat → project settings → sub-page → Back → Back lands on the chat, one entry each', () => {
    r.nav(CHAT);
    r.nav('settings/project?projectDir=%2Fp&chatId=abc');
    r.nav('settings/project/output?projectDir=%2Fp&chatId=abc');
    r.back('settings/project?projectDir=%2Fp&chatId=abc');
    assert.equal(r.route.value.name, 'settingsProject');
    r.back(CHAT);
    assert.equal(r.route.value.name, 'chat');
    assert.equal(b.h.index, 1, 'still the original chat entry');
    b.win.history.back();
    assert.equal(r.route.value.name, 'chats', 'system Back continues to the list, not into settings');
  });
}

{
  const b = makeBrowser('#/settings');
  const r = await loadRouter(b);
  ok('Back matches the route, not the literal hash (query order, #/ vs #/projects)', () => {
    r.nav('settings/mcp?from=projects&projectDir=%2Fp');
    r.nav('settings/mcp/new?projectDir=%2Fp&scope=project&from=projects');
    r.back('settings/mcp?projectDir=%2Fp&from=projects');
    assert.equal(b.h.index, 1);
    assert.equal(b.win.location.hash, '#/settings/mcp?from=projects&projectDir=%2Fp');
  });
}

{
  const b = makeBrowser('#/settings/mcp');
  const r = await loadRouter(b);
  ok('replace() turns a "new" form into the saved editor in place', () => {
    r.nav('settings/mcp/new?scope=app');
    r.replace('settings/mcp/fx?scope=app');
    assert.deepEqual(b.hashes(), ['#/settings/mcp', '#/settings/mcp/fx?scope=app']);
    r.back('settings/mcp');
    assert.equal(b.h.index, 0, 'Back from the editor skips the replaced blank form');
  });
}

{
  const b = makeBrowser('#/projects');
  const r = await loadRouter(b);
  r.nav(CHAT);
  r.nav('settings/project?projectDir=%2Fp&chatId=abc');
  // A reload: same history entries and state, same sessionStorage, fresh module.
  const r2 = await loadRouter(b);
  ok('the chain survives a reload', () => {
    r2.back(CHAT);
    assert.equal(b.h.index, 1);
    assert.equal(r2.route.value.name, 'chat');
  });
  void r;
}

{
  const b = makeBrowser('#/projects');
  const r = await loadRouter(b);
  ok('browser Back/Forward keep the book in step', () => {
    r.nav(CHAT);
    r.nav('settings/project?projectDir=%2Fp&chatId=abc');
    b.win.history.back();
    b.win.history.go(1);
    r.back(CHAT);
    assert.equal(b.h.index, 1);
  });
}

{
  const b = makeBrowser('#/settings');
  await loadRouter(b);
  const click = (href, extra = {}) => {
    let prevented = extra.prevented || false;
    const link = { getAttribute: () => href };
    const event = {
      button: 0, ...extra,
      get defaultPrevented() { return prevented; },
      preventDefault() { prevented = true; },
      target: { closest: (sel) => (sel === 'a.view-back' ? link : null) }
    };
    b.listeners.click.forEach((fn) => fn(event));
    return prevented;
  };
  ok('a tap on a view-back link goes back instead of following the href', () => {
    b.win.location.hash = '#/settings/providers';
    assert.equal(click('#/settings'), true);
    assert.equal(b.h.index, 0);
    assert.deepEqual(b.hashes(), ['#/settings', '#/settings/providers'], 'nothing pushed');
  });
  ok('modified clicks and handled clicks are left alone', () => {
    b.win.location.hash = '#/settings/providers';
    assert.equal(click('#/settings', { metaKey: true }), false);
    assert.equal(click('#/settings', { prevented: true }), true);
    assert.equal(b.h.index, 1, 'no navigation happened');
  });
}

delete globalThis.window;
delete globalThis.document;
console.log('\n--- ' + passed + ' passed, 0 failed ---');
