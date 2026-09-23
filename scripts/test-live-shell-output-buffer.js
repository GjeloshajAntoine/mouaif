'use strict';

// Regression test: shell output that arrives BEFORE its tool card exists must
// not be dropped.
//
// A follower's live stream delivers `shell_output` chunks but NOT `tool_call`
// (that row is persisted, so the follower learns about it from the message
// sync, which can land strictly later than the command's first output). The
// old handleShellOutputEvent returned false when no card matched the call id,
// and the live stream had already advanced its cursor past the frame — so the
// chunk was gone for good. Every command followed from a returning page lost
// its opening second of output.
//
// The fix parks the chunk per call id (bufferPendingShellOutput) and drains it
// when the card is finally built (takePendingShellOutput, called from
// appendToolCallCard). This test drives transcript.js in a VM with a DOM stub
// and asserts on the rendered <pre> text, so removing the fix fails it:
// without the buffer the preview stays empty.
//
// A second case pins the stderr separator: the marker is inserted when the
// first stderr chunk lands, whether that chunk was buffered or live, and only
// once.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHAT_DIR = path.join(__dirname, '../frontend/src/components/chat');

// ---- DOM stub ---------------------------------------------------------

function camelAttr(name) {
  return String(name).replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function makeNode(tag) {
  const classes = new Set();
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    _text: '',
    hidden: false,
    attributes: {},
    classList: {
      add(...names) { for (const n of names) classes.add(n); },
      remove(...names) { for (const n of names) classes.delete(n); },
      contains(name) { return classes.has(name); },
      toggle(name) { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; }
    },
    get className() { return Array.from(classes).join(' '); },
    set className(value) {
      classes.clear();
      for (const part of String(value || '').split(/\s+/)) if (part) classes.add(part);
    },
    get textContent() { return node._text; },
    set textContent(value) {
      node._text = value == null ? '' : String(value);
      node.children.length = 0;
    },
    get childElementCount() { return node.children.length; },
    get firstChild() { return node.children[0] || null; },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null; },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      // A <pre> accumulates text like the real element does.
      if (node.tagName === 'PRE' && child.nodeType === 3) node._text += child._text;
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = node;
      const at = node.children.indexOf(ref);
      if (at === -1) node.children.push(child);
      else node.children.splice(at, 0, child);
      return child;
    },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    replaceChild(fresh, old) {
      const at = node.children.indexOf(old);
      if (at === -1) return node.appendChild(fresh);
      fresh.parentNode = node;
      old.parentNode = null;
      node.children[at] = fresh;
      return old;
    },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    matches(selector) { return matchesSelector(node, selector); },
    closest(selector) {
      let cur = node.parentNode;
      while (cur) { if (matchesSelector(cur, selector)) return cur; cur = cur.parentNode; }
      return null;
    },
    querySelector(selector) { return find(node, selector); },
    querySelectorAll(selector) { return findAll(node, selector); },
    addEventListener() {},
    removeEventListener() {}
  };
  return node;
}

function matchesSimple(node, selector) {
  const parts = String(selector).trim().match(/^([a-zA-Z-]+)?((?:[.#][\w-]+)*)$/);
  if (!parts) return false;
  if (parts[1] && node.tagName !== parts[1].toUpperCase()) return false;
  const rest = parts[2] || '';
  for (const token of rest.match(/[.#][\w-]+/g) || []) {
    const name = token.slice(1);
    if (token[0] === '.' && !node.classList.contains(name)) return false;
    if (token[0] === '#' && node.getAttribute('id') !== name) return false;
  }
  return true;
}

// Supports the compound selectors transcript.js actually uses on this path:
// `[data-tool-id="x"]`, `.a .b`, `.a > .b`, and `:not(...)` -free plain rules.
//
// `[data-*]` is resolved through `dataset` as well as `attributes`:
// transcript.js sets `card.dataset.toolId` (a property write), while the
// selector it later queries with is `[data-tool-id="…"]` — the two are the
// same attribute in a real DOM, so the stub has to bridge them or every
// by-id lookup misses.
function attributeFor(node, dashed) {
  const direct = node.getAttribute(dashed);
  if (direct != null) return direct;
  const camel = camelAttr(dashed);
  return Object.prototype.hasOwnProperty.call(node.dataset, camel) ? String(node.dataset[camel]) : null;
}

function matchesSelector(node, selector) {
  const sel = String(selector).trim();
  if (sel.includes(',')) return sel.split(',').some((part) => matchesSelector(node, part));
  const attr = sel.match(/^\[(data-[\w-]+)="((?:[^"\\]|\\.)*)"\]$/);
  if (attr) {
    // Unescape the CSS-escaped value cssEscape produced (backslash escapes).
    const wanted = attr[2].replace(/\\(.)/g, '$1');
    return attributeFor(node, attr[1]) === wanted;
  }
  const childCombinator = sel.split('>').map((s) => s.trim());
  if (childCombinator.length === 2) {
    const parent = node.parentNode;
    if (!parent || !matchesSimple(parent, childCombinator[0])) return false;
    return matchesSimple(node, childCombinator[1]);
  }
  const descendant = sel.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (descendant.length > 1) {
    const last = descendant[descendant.length - 1];
    if (!matchesSimple(node, last)) return false;
    let cur = node.parentNode;
    const rest = descendant.slice(0, -1).reverse();
    let idx = 0;
    while (cur && idx < rest.length) {
      if (matchesSimple(cur, rest[idx])) idx++;
      cur = cur.parentNode;
    }
    return idx === rest.length;
  }
  return matchesSimple(node, sel);
}

function find(root, selector) {
  for (const child of root.children) {
    if (child.nodeType !== 1) continue;
    if (matchesSelector(child, selector)) return child;
    const deeper = find(child, selector);
    if (deeper) return deeper;
  }
  return null;
}

function findAll(root, selector) {
  const out = [];
  for (const child of root.children) {
    if (child.nodeType !== 1) continue;
    if (matchesSelector(child, selector)) out.push(child);
    out.push(...findAll(child, selector));
  }
  return out;
}

function installDom() {
  const frames = new Map();
  let nextId = 0;
  const raf = (fn) => { frames.set(++nextId, fn); return nextId; };
  const caf = (id) => { frames.delete(id); };
  const document = {
    createElement: makeNode,
    createTextNode: (text) => {
      const n = makeNode('#text');
      n.nodeType = 3;
      n._text = String(text);
      return n;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };
  return {
    document,
    window: { requestAnimationFrame: raf, cancelAnimationFrame: caf, addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
}

// ---- Module loader ----------------------------------------------------

function loadTranscript(globals) {
  const source = fs.readFileSync(path.join(CHAT_DIR, 'transcript.js'), 'utf8');
  const body = source
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  // The module's own tool helpers, loaded the same way rather than stubbed:
  // appendToolCallCard branches on normalizeToolName(...) === 'shell', so a
  // stub that returns undefined would take the wrong branch and the shell
  // preview under test would never be built.
  const toolsSrc = fs.readFileSync(path.join(CHAT_DIR, 'tools.js'), 'utf8');
  const toolsBody = toolsSrc
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  const base = Object.assign({
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, WeakSet, Promise, Error, RegExp,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    afterTranscriptAppend() {},
    updateUsageSummary() {},
    scrollToolBodyToBottom() {},
    pinTranscriptAfterSettle() {},
    updateJumpButton() {},
    renderMarkdown: (t) => t,
    copyText: async () => true,
    messageCopyText: (m) => (m && m.content) || ''
  }, globals);
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(toolsBody + '; this.TOOLS = { normalizeToolName, isSubagentTool, formatToolArgs, isExpectedToolFailure, coerceToolResult, formatResultSummary, formatReadableToolResult };', context);
  // Re-expose the tool helpers as bare globals for transcript.js, and give it
  // the two values it reads from the other chat modules (tools.js constants and
  // utils.js cssEscape). A stubbed cssEscape would return undefined, and the
  // `[data-tool-id="…"]` lookups would then miss every card.
  vm.runInContext('for (const k of Object.keys(this.TOOLS)) this[k] = this.TOOLS[k]; this.TOOL_ARGS_PREVIEW_CHARS = 400;'
    + ' this.cssEscape = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, (c) => "\\\\" + c);', context);
  vm.runInContext(body + '; this.appendToolCallCard = appendToolCallCard;'
    + ' this.handleShellOutputEvent = handleShellOutputEvent;'
    + ' this.bufferPendingShellOutput = bufferPendingShellOutput;'
    + ' this.takePendingShellOutput = takePendingShellOutput;', context);
  return context;
}

// ---- Harness ----------------------------------------------------------

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

function makeRefs(el) {
  return {
    transcript: { current: el },
    pinnedToBottom: { current: true },
    pendingCount: { current: 0 },
    jumpBtn: { current: null },
    usageSummary: { current: null },
    setupCard: { current: null },
    _insertAnchor: null,
    _pendingTranscriptChunk: null,
    _suspendScrollPin: false,
    _autoresize() {}
  };
}

function shellCardPre(el, callId) {
  const card = find(el, '[data-tool-id="' + callId + '"]');
  return card ? find(card, '.tool-card__shell-live-pre') : null;
}

function main() {
  const globals = installDom();
  const mod = loadTranscript(globals);

  // ---- 1. Output that arrives before its card is not lost -----------
  {
    const el = makeNode('div');
    const refs = makeRefs(el);
    const state = { messages: [], chat: {} };
    check('no card exists yet', shellCardPre(el, 'call_1') === null);

    const before = mod.handleShellOutputEvent({ id: 'call_1', stream: 'stdout', delta: 'line one\n' }, refs);
    check('a chunk with no card is accepted, not dropped', before === true);
    mod.handleShellOutputEvent({ id: 'call_1', stream: 'stdout', delta: 'line two\n' }, refs);
    const buffered = mod.takePendingShellOutput(refs, 'call_1');
    check('the chunks are held per call id', buffered.length === 2, 'held=' + buffered.length);

    // Re-buffer, then build the card the way the live stream would.
    mod.handleShellOutputEvent({ id: 'call_1', stream: 'stdout', delta: 'line one\n' }, refs);
    mod.handleShellOutputEvent({ id: 'call_1', stream: 'stdout', delta: 'line two\n' }, refs);
    mod.appendToolCallCard({ id: 'call_1', name: 'shell', args: { cmd: 'ls' } }, refs);
    const pre = shellCardPre(el, 'call_1');
    check('the card is created', !!pre);
    check('the held output is drained into the card preview',
      pre && pre.textContent === 'line one\nline two\n', pre && JSON.stringify(pre.textContent));
    check('the hold is claimed exactly once',
      mod.takePendingShellOutput(refs, 'call_1').length === 0);
  }

  // ---- 2. Later chunks append to the same preview -------------------
  {
    const el = makeNode('div');
    const refs = makeRefs(el);
    mod.bufferPendingShellOutput(refs, { id: 'call_2', stream: 'stdout', delta: 'first' });
    mod.appendToolCallCard({ id: 'call_2', name: 'shell', args: {} }, refs);
    mod.handleShellOutputEvent({ id: 'call_2', stream: 'stdout', delta: ' second' }, refs);
    const pre = shellCardPre(el, 'call_2');
    check('pre-card output and post-card output are joined',
      pre && pre.textContent === 'first second', pre && JSON.stringify(pre.textContent));
  }

  // ---- 3. The stderr separator, buffered and live -------------------
  {
    const el = makeNode('div');
    const refs = makeRefs(el);
    mod.bufferPendingShellOutput(refs, { id: 'call_3', stream: 'stdout', delta: 'out\n' });
    mod.bufferPendingShellOutput(refs, { id: 'call_3', stream: 'stderr', delta: 'err\n' });
    mod.appendToolCallCard({ id: 'call_3', name: 'shell', args: {} }, refs);
    const pre = shellCardPre(el, 'call_3');
    check('a buffered stderr chunk inserts the separator once',
      pre && pre.textContent === 'out\n\n── stderr ──\nerr\n', pre && JSON.stringify(pre.textContent));
    check('the buffered stderr chunk marks the preview',
      pre && pre.dataset.hasStderr === '1', pre && String(pre.dataset.hasStderr));

    mod.handleShellOutputEvent({ id: 'call_3', stream: 'stderr', delta: 'more\n' }, refs);
    const count = (pre.textContent.match(/── stderr ──/g) || []).length;
    check('a second stderr chunk does not repeat the separator', count === 1, 'markers=' + count);
  }

  // ---- 4. The hold is bounded --------------------------------------
  {
    const el = makeNode('div');
    const refs = makeRefs(el);
    const big = 'x'.repeat(40 * 1024);
    mod.bufferPendingShellOutput(refs, { id: 'call_4', stream: 'stdout', delta: big });
    mod.bufferPendingShellOutput(refs, { id: 'call_4', stream: 'stdout', delta: big });
    mod.bufferPendingShellOutput(refs, { id: 'call_4', stream: 'stdout', delta: big });
    const held = mod.takePendingShellOutput(refs, 'call_4');
    const chars = held.reduce((n, c) => n + c.delta.length, 0);
    check('the hold stops growing at its cap', chars <= 64 * 1024, 'chars=' + chars);
    check('the cap still keeps what arrived first', held.length > 0 && held[0].delta.length === big.length);
  }

  // ---- 5. A missing call id is not buffered under a shared key -----
  {
    const el = makeNode('div');
    const refs = makeRefs(el);
    const ok = mod.handleShellOutputEvent({ stream: 'stdout', delta: 'no id' }, refs);
    check('a chunk with no call id is not parked', ok === false);
    check('no hold was created for it', mod.takePendingShellOutput(refs, '').length === 0);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
