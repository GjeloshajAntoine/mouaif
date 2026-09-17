'use strict';

// Regression test: appending rows must not destroy an in-flight backfill.
//
// renderTranscriptChunked() paints the newest rows first and then fills in
// older history above them, one animation frame at a time, inserting
// before refs._insertAnchor. syncTranscriptAppend() (the live/reconcile
// append path) opened with resetTranscriptRender(), which bumps the render
// token and cancels the pending frame — so the backfill's next frame saw a
// stale token, returned immediately, and nothing ever resumed it:
//
//   * every history row the pass had not reached stayed in state.messages
//     but never reached the DOM, leaving a hole in the middle of the
//     transcript until some later full rebuild;
//   * the append had to clear the anchor first, because transcriptInsert()
//     targets it while it is set — which is why the two paths collided.
//
// The new rows belong at the bottom and the backfill keeps inserting above
// the tail, so the append now parks the anchor for its own writes and hands
// it back, leaving the backfill frame alone.
//
// transcript.js is loaded the way the other transcript tests load it: the
// import block is stripped and the body is executed in a VM whose globals
// auto-provide the module's helpers. The assertions are about the resulting
// element order and the surviving frame, not about source shape — remove
// the fix and three of them fail.

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
  const frames = new Map();
  const stats = { requested: 0, cancelled: 0 };
  let nextId = 0;
  const raf = (fn) => { stats.requested++; frames.set(++nextId, fn); return nextId; };
  const caf = (id) => { stats.cancelled++; frames.delete(id); };
  // The test body schedules frames itself, so expose the stubs globally too.
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = caf;
  return {
    stats,
    globals: {
      document: {
        createElement,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {}
      },
      window: {
        requestAnimationFrame: raf,
        cancelAnimationFrame: caf,
        addEventListener() {},
        removeEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      },
      requestAnimationFrame: raf,
      cancelAnimationFrame: caf,
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
    JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    // helpers the module calls; the paths under test do not depend on their
    // behaviour, only on the ordering they participate in.
    afterTranscriptAppend() {},
    updateUsageSummary() {},
    scrollToolBodyToBottom() {},
    pinTranscriptAfterSettle() {},
    updateJumpButton() {},
    import_meta: undefined
  }, globals);
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(body + '; this.syncTranscriptAppend = syncTranscriptAppend; this.appendMessageToTranscript = appendMessageToTranscript;', context);
  return context;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

function message(i) {
  return { role: 'user', content: 'message ' + i, ts: '2026-01-01T00:00:0' + (i % 10) + '.000Z' };
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

function rowLabels(el) {
  return el.children.map((child) => {
    const body = child.children.find((c) => c.className === 'chat-msg__body');
    return body ? body.textContent : '<' + child.className + '>';
  });
}

// Paint the newest rows the way the chunked pass' tail phase does: plain
// appends with no anchor set.
function paintTail(mod, state, refs, count) {
  for (let i = 0; i < count; i++) mod.appendMessageToTranscript(state.messages[i], false, refs, state);
}

function main() {
  const dom = installDom();
  const mod = loadTranscript(dom.globals);

  // ---- 1. A plain append keeps chronological order -----------------
  {
    const el = createElement('div');
    const refs = makeRefs(el);
    const state = { messages: [message(0), message(1)], chat: {} };
    paintTail(mod, state, refs, 2);
    state.messages = state.messages.concat([message(2), message(3)]);
    mod.syncTranscriptAppend(state, refs, 2);
    check('the appended rows land at the end',
      JSON.stringify(rowLabels(el)) === JSON.stringify(['message 0', 'message 1', 'message 2', 'message 3']),
      JSON.stringify(rowLabels(el)));
  }

  // ---- 2. An in-flight backfill survives the append ----------------
  {
    const el = createElement('div');
    const refs = makeRefs(el);
    const state = { messages: [message(0), message(1)], chat: {} };
    paintTail(mod, state, refs, 2);
    // The chunked pass is mid-flight: older rows will be inserted before
    // the first tail row, which is the current anchor.
    const anchor = el.children[0];
    refs._insertAnchor = anchor;
    refs._pendingTranscriptChunk = requestAnimationFrame(() => {});
    const before = dom.stats.cancelled;

    state.messages = state.messages.concat([message(2)]);
    mod.syncTranscriptAppend(state, refs, 2);

    check('the pending backfill frame is not cancelled',
      dom.stats.cancelled === before, 'cancelled=' + (dom.stats.cancelled - before));
    check('the backfill anchor is handed back for the next frame',
      refs._insertAnchor === anchor, String(refs._insertAnchor && refs._insertAnchor.className));
    check('the appended row landed after the tail, not above it',
      JSON.stringify(rowLabels(el)) === JSON.stringify(['message 0', 'message 1', 'message 2']),
      JSON.stringify(rowLabels(el)));

    // The resumed frame then inserts an older row before the anchor: tail
    // and appended row must keep their relative order.
    const older = createElement('div');
    older.className = 'chat-msg chat-msg--user';
    el.insertBefore(older, anchor);
    check('a resumed backfill still inserts above the tail',
      el.children.indexOf(older) === 0 && el.children.indexOf(anchor) === 1,
      'older=' + el.children.indexOf(older) + ' anchor=' + el.children.indexOf(anchor));
    check('the appended row stays last', el.children[el.children.length - 1].className.includes('chat-msg'));
  }

  // ---- 3. Nothing to append leaves the backfill alone --------------
  {
    const el = createElement('div');
    const refs = makeRefs(el);
    const state = { messages: [message(0)], chat: {} };
    paintTail(mod, state, refs, 1);
    const anchor = el.children[0];
    refs._insertAnchor = anchor;
    refs._pendingTranscriptChunk = requestAnimationFrame(() => {});
    const before = dom.stats.cancelled;
    mod.syncTranscriptAppend(state, refs, 1);
    check('a no-op append touches nothing',
      dom.stats.cancelled === before && refs._insertAnchor === anchor);
  }

  // The prevCount === 0 branch (empty transcript) still calls the full
  // render, which re-owns the transcript and supersedes the backfill. It
  // is not exercised here: renderTranscript mounts the setup card, the
  // system prompt, and the tools card, which needs the real card builders
  // rather than the auto-stubs this harness supplies.

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
