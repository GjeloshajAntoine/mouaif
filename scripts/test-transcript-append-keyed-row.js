'use strict';

// Regression test: the cheap tail-append path must not draw a row whose node
// is already on screen under the same identity.
//
// This is the ordinary live-follower completion path. `finalizeLiveSegment`
// stamps the streamed bubble with the persisted row's `seq` (see live.js →
// assistant_turn_end), but the follower never adds its live reply to
// `state.messages`. When the persisted row arrives, mergeServerRows therefore
// sees a pure append and `tailSyncDomAction` returns 'append', routing to
// `syncTranscriptAppend` — never to `reconcileTranscriptRows`, which is the
// only path that matched rows by key. Rendering the row unconditionally built
// a SECOND bubble next to the live one.
//
// The assertions below fail if the keyed-row guard is removed from
// syncTranscriptAppend.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- DOM stub --------------------------------------------------------

function createElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    dataset: {},
    style: {},
    childElementCount: 0,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 800,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    attributes: {},
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null; },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      node.childElementCount = node.children.length;
      return child;
    },
    insertBefore(child, ref) {
      // Like the real DOM: inserting a node that is already a child moves it.
      const from = node.children.indexOf(child);
      if (from >= 0) node.children.splice(from, 1);
      child.parentNode = node;
      const at = node.children.indexOf(ref);
      if (at === -1) node.children.push(child);
      else node.children.splice(at, 0, child);
      node.childElementCount = node.children.length;
      return child;
    },
    removeChild(child) {
      const i = node.children.indexOf(child);
      if (i >= 0) node.children.splice(i, 1);
      child.parentNode = null;
      node.childElementCount = node.children.length;
      return child;
    },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {}
  };
  return node;
}

function installDom() {
  const raf = () => 1;
  return {
    globals: {
      document: {
        createElement,
        createTextNode: (t) => ({ nodeType: 3, textContent: t }),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {}
      },
      window: {
        requestAnimationFrame: raf,
        cancelAnimationFrame() {},
        addEventListener() {},
        removeEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      },
      requestAnimationFrame: raf,
      cancelAnimationFrame() {},
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
    }
  };
}

// ---- Module loader ---------------------------------------------------

function loadTranscript(globals) {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/transcript.js'), 'utf8');
  const body = source
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  const base = Object.assign({
    console,
    JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, Promise, Error, Symbol,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    afterTranscriptAppend() {},
    updateUsageSummary() {},
    // Stands in for usage.js: un-hides the line and records what it drew.
    renderUsageMeta(el, info) { el.hidden = false; el._drawn = info; },
    scrollToolBodyToBottom() {},
    pinTranscriptAfterSettle() {},
    updateJumpButton() {},
    import_meta: undefined
  }, globals);
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(body + '; this.syncTranscriptAppend = syncTranscriptAppend;'
    + ' this.appendMessageToTranscript = appendMessageToTranscript;'
    + ' this.transcriptRowKey = transcriptRowKey;'
    + ' this.reconcileTranscriptRows = reconcileTranscriptRows;', context);
  return context;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

function makeRefs(transcriptEl) {
  return {
    transcript: { current: transcriptEl },
    pinnedToBottom: { current: true },
    pendingCount: { current: 0 },
    jumpBtn: { current: null },
    usageSummary: { current: null },
    _insertAnchor: null,
    _pendingTranscriptChunk: null,
    _suspendScrollPin: false,
    _autoresize() {}
  };
}

function rows(el) {
  return el.children.filter((c) => String(c.className || '').indexOf('chat-msg') === 0);
}

function main() {
  const dom = installDom();
  const mod = loadTranscript(dom.globals);

  // ---- 1. A finalized live bubble is not drawn twice -----------------
  {
    const el = createElement('div');
    const refs = makeRefs(el);
    const state = { messages: [], chat: {} };

    // The user turn and the live assistant bubble the follower streamed into.
    const user = { role: 'user', content: 'hi', ts: '2026-01-01T00:00:00.000Z' };
    mod.appendMessageToTranscript(user, false, refs, state);
    const live = { role: 'assistant', content: '', reasoning: '', ts: '2026-01-01T00:00:01.000Z', modelId: 'm' };
    mod.appendMessageToTranscript(live, true, refs, state);
    const liveRow = el.children[el.children.length - 1];
    liveRow._content = 'the answer';
    // finalizeLiveSegment adopts the persisted row's seq onto the live node.
    liveRow._rowKey = 'seq:7';

    check('two rows on screen before the sync (user + live bubble)', rows(el).length === 2, 'rows=' + rows(el).length);

    // state.messages gets the optimistic user row plus the persisted assistant
    // row — the live bubble is NOT in state.messages (the follower path).
    state.messages = [user, { role: 'assistant', content: 'the answer', reasoning: '', ts: '2026-01-01T00:00:02.000Z', seq: 7 }];
    mod.syncTranscriptAppend(state, refs, 1);

    check('the persisted row reconciles onto the live bubble (no duplicate)', rows(el).length === 2,
      'rows=' + rows(el).length + ' classes=' + JSON.stringify(rows(el).map((r) => r.className)));
    check('the surviving row is the one that was streaming', el.children[el.children.length - 1] === liveRow);
  }

  // ---- 2. A genuinely new row is still appended ----------------------
  {
    const el = createElement('div');
    const refs = makeRefs(el);
    const state = { messages: [], chat: {} };
    const a = { role: 'user', content: 'one', ts: '2026-01-01T00:00:00.000Z', seq: 1 };
    mod.appendMessageToTranscript(a, false, refs, state);
    el.children[el.children.length - 1]._rowKey = 'seq:1';

    state.messages = [a, { role: 'assistant', content: 'two', ts: '2026-01-01T00:00:01.000Z', seq: 2 }];
    mod.syncTranscriptAppend(state, refs, 1);
    check('an unseen keyed row is still appended', rows(el).length === 2, 'rows=' + rows(el).length);
    check('the appended row carries its key', mod.transcriptRowKey(state.messages[1]) === el.children[el.children.length - 1]._rowKey,
      String(el.children[el.children.length - 1]._rowKey));
  }

  // ---- 3. An unkeyed row still appends (object identity, no match) ----
  {
    const el = createElement('div');
    const refs = makeRefs(el);
    const state = { messages: [], chat: {} };
    const a = { role: 'user', content: 'one', ts: '2026-01-01T00:00:00.000Z' };
    mod.appendMessageToTranscript(a, false, refs, state);
    el.children[el.children.length - 1]._rowKey = 'seq:1';

    const b = { role: 'assistant', content: 'two', ts: '2026-01-01T00:00:01.000Z' };
    state.messages = [a, b];
    mod.syncTranscriptAppend(state, refs, 1);
    check('a row with a fresh object identity is appended', rows(el).length === 2, 'rows=' + rows(el).length);
  }

  // ---- 4. A reused follower bubble gets its info line ----------------
  // The live bubble is drawn with the line hidden; the saved row that lands
  // on the same node must fill it in, on both sync paths.
  for (const path of ['append', 'reconcile']) {
    const el = createElement('div');
    const refs = makeRefs(el);
    const state = { messages: [], chat: {} };
    const user = { role: 'user', content: 'hi', ts: '2026-01-01T00:00:00.000Z', seq: 1 };
    mod.appendMessageToTranscript(user, false, refs, state);
    el.children[el.children.length - 1]._rowKey = 'seq:1';
    mod.appendMessageToTranscript({ role: 'assistant', content: '', reasoning: '' }, true, refs, state);
    const liveRow = el.children[el.children.length - 1];
    liveRow._content = 'the answer';
    // What finalizeLiveSegment does at the segment's end.
    delete liveRow.dataset.live;
    liveRow._rowKey = 'cid:a1';
    const meta = liveRow.children.find((c) => c.className === 'chat-msg__meta');
    check(path + ': the live bubble starts with a hidden info line', !!meta && meta.hidden === true);

    const saved = { role: 'assistant', content: 'the answer', seq: 2, clientId: 'a1', modelId: 'm',
      usage: { promptTokens: 10, completionTokens: 5 } };
    state.messages = [user, saved];
    if (path === 'append') mod.syncTranscriptAppend(state, refs, 1);
    else mod.reconcileTranscriptRows(state, refs, [0, 1]);
    check(path + ': the node is reused', rows(el).length === 2 && el.children[el.children.length - 1] === liveRow);
    check(path + ': the saved row fills the info line', meta.hidden === false && meta._drawn === saved);

    // A line that already shows is not redrawn (the owner's live tok/s stays).
    meta._drawn = 'kept';
    if (path === 'append') { state.messages = [user, saved]; mod.syncTranscriptAppend(state, refs, 1); }
    else mod.reconcileTranscriptRows(state, refs, [0, 1]);
    check(path + ': a visible info line is left alone', meta._drawn === 'kept');

    // The line a follower drew while streaming has no cost: the saved row
    // replaces it, once.
    meta._provisional = true;
    if (path === 'append') mod.syncTranscriptAppend(state, refs, 1);
    else mod.reconcileTranscriptRows(state, refs, [0, 1]);
    check(path + ': a provisional info line is replaced by the saved row',
      meta._drawn === saved && meta._provisional === false);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
