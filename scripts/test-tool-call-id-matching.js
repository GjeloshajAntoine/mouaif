'use strict';
// Regression test: an unidentified tool_call and its tool_result must share
// one card.
//
// Not every provider echoes a tool-call id, and a few internal call sites
// pass `id: null` on purpose (a subagent that failed to start, a tool/MCP
// error result). appendToolCallCard() and appendToolResultCard() each used
// to mint an INDEPENDENT random id in that case, so the result could never
// find the call card:
//
//   * the transcript grew a second, standalone result card, and
//   * the original call card stayed stuck on "Waiting for results…"
//     forever, because nothing ever updated it.
//
// appendToolCallCard() now parks the id it minted in refs._anonToolCalls,
// and appendToolResultCard() adopts it — preferring an entry whose tool
// name matches, and never reusing an entry whose card has left the tree.
//
// transcript.js is loaded the way the other transcript tests load it: the
// import block is stripped and the body runs in a VM whose globals supply
// the module's helpers. Remove the fix and the first assertions fail with
// two cards instead of one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- DOM stub --------------------------------------------------------
function createElement(tag) {
  const classes = new Set();
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    _root: false,
    textContent: '',
    innerHTML: '',
    hidden: false,
    dataset: {},
    style: {},
    childElementCount: 0,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 800,
    get className() { return Array.from(classes).join(' '); },
    set className(v) {
      classes.clear();
      for (const c of String(v || '').split(/\s+/)) if (c) classes.add(c);
    },
    classList: {
      add(...list) { for (const c of list) classes.add(c); },
      remove(...list) { for (const c of list) classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
    },
    get isConnected() {
      let n = node;
      while (n) { if (n._root) return true; n = n.parentNode; }
      return false;
    },
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
    attrs: {},
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null; },
    removeAttribute(name) { delete node.attrs[name]; },
    closest(selector) {
      const m = /^\.([A-Za-z0-9_-]+)$/.exec(selector);
      let n = node.parentNode;
      while (n) {
        if (m && n.classList && n.classList.contains(m[1])) return n;
        n = n.parentNode;
      }
      if (m && node.classList && node.classList.contains(m[1])) return node;
      return null;
    },
    matches(selector) {
      const m = /^\[data-tool-id="([^"]+)"\]$/.exec(selector);
      if (m) return String(node.dataset.toolId) === m[1];
      return false;
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const m = /^\[data-tool-id="([^"]+)"\]$/.exec(selector);
      if (!m) return [];
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (String(c.dataset && c.dataset.toolId) === m[1]) out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    },
    addEventListener() {},
    removeEventListener() {}
  };
  return node;
}

function installDom() {
  const frames = new Map();
  let nextId = 0;
  const raf = (fn) => { frames.set(++nextId, fn); return nextId; };
  const caf = (id) => { frames.delete(id); };
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = caf;
  return {
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
    JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    // Real behaviour for the helpers the assertion depends on.
    normalizeToolName: (name) => String(name || '').replace(/^functions\./, ''),
    cssEscape: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, (c) => '\\' + c),
    isSubagentTool: (name) => normalize(name) === 'subagent',
    coerceToolResult: (result) => (result && typeof result === 'object' ? result : { text: String(result || '') }),
    formatResultSummary: () => 'summary',
    isExpectedToolFailure: () => false,
    formatToolArgs: () => 'args',
    buildToolCardHead: () => createElement('div'),
    isPersistedTurnError: () => false,
    publishWebPreview() {},
    // Ordering-only helpers.
    afterTranscriptAppend() {},
    updateUsageSummary() {},
    scrollToolBodyToBottom() {},
    pinTranscriptAfterSettle() {},
    updateJumpButton() {}
  }, globals);
  function normalize(name) { return String(name || '').replace(/^functions\./, ''); }
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(
    body + '; this.appendToolCallCard = appendToolCallCard; this.appendToolResultCard = appendToolResultCard;',
    context
  );
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

function toolCards(el) {
  return el.children.filter((c) => c.classList.contains('tool-card'));
}

function main() {
  const globals = installDom();
  const mod = loadTranscript(globals);

  // ---- 1. id-less call + id-less result share one card -------------
  {
    const el = createElement('div');
    el._root = true;
    const refs = makeRefs(el);
    mod.appendToolCallCard({ name: 'shell', args: { cmd: 'ls' } }, refs);
    check('the call card is on screen', toolCards(el).length === 1);
    const callId = toolCards(el)[0].dataset.toolId;
    check('the call card carries a minted id', typeof callId === 'string' && callId.length > 0);

    mod.appendToolResultCard({ name: 'shell', ok: true, result: { output: 'ok' } }, refs);
    check('the result updates the call card instead of adding a second one',
      toolCards(el).length === 1, 'cards=' + toolCards(el).length);
    check('the card kept the call id', toolCards(el)[0].dataset.toolId === callId);
    check('the card became a result card',
      toolCards(el)[0].classList.contains('tool-card--result')
      && !toolCards(el)[0].classList.contains('tool-card--call'));
  }

  // ---- 2. the right unidentified call is picked by tool name -------
  {
    const el = createElement('div');
    el._root = true;
    const refs = makeRefs(el);
    mod.appendToolCallCard({ name: 'shell', args: { cmd: 'ls' } }, refs);
    mod.appendToolCallCard({ name: 'subagent', args: { prompt: 'go' } }, refs);
    const [shellCard, subagentCard] = toolCards(el);
    mod.appendToolResultCard({ name: 'subagent', ok: true, result: { text: 'done' } }, refs);
    check('the name-matching call is updated, not the older one',
      subagentCard.classList.contains('tool-card--result')
      && shellCard.classList.contains('tool-card--call'), 'cards=' + toolCards(el).length);
    check('no duplicate card was appended', toolCards(el).length === 2, 'cards=' + toolCards(el).length);

    // The shell result then claims the remaining entry.
    mod.appendToolResultCard({ name: 'shell', ok: true, result: { output: 'ok' } }, refs);
    check('the remaining call is claimed by the later result',
      toolCards(el).length === 2 && shellCard.classList.contains('tool-card--result'));
  }

  // ---- 3. an explicit id still wins (no regression) ----------------
  {
    const el = createElement('div');
    el._root = true;
    const refs = makeRefs(el);
    mod.appendToolCallCard({ id: 'real-1', name: 'shell', args: { cmd: 'ls' } }, refs);
    mod.appendToolResultCard({ id: 'real-1', name: 'shell', ok: true, result: {} }, refs);
    check('an identified call keeps its own id',
      toolCards(el).length === 1 && toolCards(el)[0].dataset.toolId === 'real-1');
    check('an identified call is not registered as anonymous',
      !Array.isArray(refs._anonToolCalls) || refs._anonToolCalls.length === 0);
  }

  // ---- 4. a rebuilt-away card is never reused ----------------------
  {
    const el = createElement('div');
    el._root = true;
    const refs = makeRefs(el);
    mod.appendToolCallCard({ name: 'shell', args: { cmd: 'ls' } }, refs);
    const stale = toolCards(el)[0];
    // A rebuild wipes the tree; the parked registration is now dangling.
    el.children = [];
    el.childElementCount = 0;
    stale.parentNode = null;
    mod.appendToolResultCard({ name: 'shell', ok: true, result: {} }, refs);
    check('a dangling registration is not handed to a new result',
      toolCards(el).length === 1 && toolCards(el)[0].dataset.toolId !== stale.dataset.toolId,
      'stale=' + stale.dataset.toolId + ' new=' + (toolCards(el)[0] && toolCards(el)[0].dataset.toolId));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
