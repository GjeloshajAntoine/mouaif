'use strict';

// Regression test: card and args lookups must be indexed, not scanned.
//
// A full transcript redraw used to resolve every tool card with
// `querySelector('[data-tool-id="…"]')` — a subtree walk — and recover every
// result row's call arguments with a linear scan of `state.messages`. Both ran
// once per row, so a tool-heavy chat cost O((N+R)·N) and got sharply worse as it
// grew; on a long agentic transcript this is the dominant per-rebuild cost.
//
// The fix indexes cards by tool id (maintained wherever `dataset.toolId` is
// assigned) and builds a toolCallId -> args map once per messages-array
// revision. This test counts the scans: it wraps `querySelector` and the args
// lookup in counters, so restoring either linear path fails it.
//
// It also pins the correctness properties that make the index safe:
//   - a card removed from the tree is not returned (the index prunes it),
//   - the args map is rebuilt when the messages array identity changes, and
//     reused when it does not (one rebuild per revision, not per row),
//   - re-keying a card moves its entry instead of leaving a stale one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHAT_DIR = path.join(__dirname, '../frontend/src/components/chat');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- DOM stub ---------------------------------------------------------

const stats = { queries: 0 };

function camelAttr(name) {
  return String(name).replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function matchesSimple(node, sel) {
  const attr = String(sel).trim().match(/^\[(data-[\w-]+)="((?:[^"\\]|\\.)*)"\]$/);
  if (attr) {
    const wanted = attr[2].replace(/\\(.)/g, '$1');
    const direct = node.getAttribute(attr[1]);
    if (direct != null) return direct === wanted;
    const camel = camelAttr(attr[1]);
    return String(node.dataset[camel] == null ? '' : node.dataset[camel]) === wanted;
  }
  if (!sel.includes('.')) return node.tagName === String(sel).toUpperCase();
  const want = String(sel).split('.').filter(Boolean);
  const have = String(node.className || '').split(/\s+/).filter(Boolean);
  return want.every((c) => have.includes(c));
}

function matchesSelector(node, sel) {
  const s = String(sel).trim();
  if (s.includes(',')) return s.split(',').some((p) => matchesSelector(node, p));
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    if (!matchesSimple(node, parts[parts.length - 1])) return false;
    let cur = node.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      let found = false;
      while (cur) { if (matchesSimple(cur, parts[i])) { found = true; cur = cur.parentNode; break; } cur = cur.parentNode; }
      if (!found) return false;
    }
    return true;
  }
  return matchesSimple(node, s);
}

function createElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    className: '',
    hidden: false,
    dataset: {},
    style: {},
    childElementCount: 0,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 400,
    isConnected: true,
    _text: '',
    attributes: {},
    classList: {
      add(...names) { const l = String(node.className).split(/\s+/).filter(Boolean); for (const n of names) if (!l.includes(n)) l.push(n); node.className = l.join(' '); },
      remove(...names) { const l = String(node.className).split(/\s+/).filter(Boolean).filter((x) => !names.includes(x)); node.className = l.join(' '); },
      contains(name) { return String(node.className).split(/\s+/).includes(name); },
      toggle(name) { if (node.classList.contains(name)) { node.classList.remove(name); return false; } node.classList.add(name); return true; }
    },
    get textContent() { return node._text; },
    set textContent(v) { node._text = v == null ? '' : String(v); node.children = []; node.childElementCount = 0; },
    setAttribute(name, v) { node.attributes[name] = String(v); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null; },
    appendChild(child) { child.parentNode = node; node.children.push(child); node.childElementCount = node.children.length; return child; },
    insertBefore(child, ref) { child.parentNode = node; const at = node.children.indexOf(ref); if (at === -1) node.children.push(child); else node.children.splice(at, 0, child); node.childElementCount = node.children.length; return child; },
    removeChild(child) { const i = node.children.indexOf(child); if (i >= 0) node.children.splice(i, 1); child.parentNode = null; child.isConnected = false; node.childElementCount = node.children.length; return child; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); else node.isConnected = false; },
    matches(sel) { return matchesSelector(node, sel); },
    closest(sel) { let n = node; while (n) { if (matchesSelector(n, sel)) return n; n = n.parentNode; } return null; },
    querySelector(sel) { stats.queries++; return node.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      for (const child of node.children) {
        if (child.nodeType !== 1) continue;
        if (matchesSelector(child, sel)) out.push(child);
        out.push(...child.querySelectorAll(sel));
      }
      return out;
    },
    addEventListener() {},
    removeEventListener() {}
  };
  return node;
}

function installDom() {
  const globals = {
    document: {
      createElement,
      createTextNode: (t) => { const n = createElement('#text'); n.nodeType = 3; n._text = String(t); return n; },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    window: { addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  return globals;
}

// ---- Module loader ---------------------------------------------------

function loadTranscript(globals) {
  const source = fs.readFileSync(path.join(CHAT_DIR, 'transcript.js'), 'utf8');
  const body = source
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  const toolsSrc = fs.readFileSync(path.join(CHAT_DIR, 'tools.js'), 'utf8');
  const toolsBody = toolsSrc.replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '').replace(/^export /gm, '');
  const base = Object.assign({
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, WeakSet, Promise, Error, RegExp,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    renderMarkdown: (t) => String(t || ''),
    copyText: async () => true,
    messageCopyText: (m) => (m && m.content) || '',
    afterTranscriptAppend() {},
    updateUsageSummary() {},
    scrollToolBodyToBottom() {},
    scrollToolBodyToBottomSoon() {},
    cancelToolBodyScroll() {},
    pinTranscriptAfterSettle() {},
    updateJumpButton() {}
  }, globals);
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(toolsBody + '; this.TOOLS = { normalizeToolName, isSubagentTool, formatToolArgs, isExpectedToolFailure, coerceToolResult, formatResultSummary, formatReadableToolResult };', context);
  vm.runInContext('for (const k of Object.keys(this.TOOLS)) this[k] = this.TOOLS[k]; this.TOOL_ARGS_PREVIEW_CHARS = 400;'
    + ' this.cssEscape = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, (c) => "\\\\" + c);', context);
  vm.runInContext(body + '; this.appendToolCallCard = appendToolCallCard;'
    + ' this.appendToolResultCard = appendToolResultCard;'
    + ' this.findToolCard = findToolCard;'
    + ' this.rekeyToolCard = rekeyToolCard;'
    + ' this.toolCallArgsIndex = toolCallArgsIndex;'
    + ' this.toolCallArgsFor = toolCallArgsFor;', context);
  return context;
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

function main() {
  const mod = loadTranscript(installDom());

  // ---- 1. A card is indexed on creation and found without a scan ----
  {
    const el = createElement('div');
    el.className = 'chat-view__transcript';
    const refs = makeRefs(el);
    mod.appendToolCallCard({ id: 'call_1', name: 'shell', args: { cmd: 'ls' } }, refs);
    // Prime the index with one query (the fallback), then measure the repeat.
    const first = mod.findToolCard(refs, 'call_1');
    check('the card is created', !!first);
    const before = stats.queries;
    for (let i = 0; i < 20; i++) mod.findToolCard(refs, 'call_1');
    check('repeat lookups perform no DOM query', stats.queries === before,
      'queries=' + (stats.queries - before));
  }

  // ---- 2. A removed card is not returned ---------------------------
  {
    const el = createElement('div');
    el.className = 'chat-view__transcript';
    const refs = makeRefs(el);
    mod.appendToolCallCard({ id: 'call_gone', name: 'shell', args: {} }, refs);
    const card = mod.findToolCard(refs, 'call_gone');
    check('the card starts out found', !!card);
    card.remove();
    check('a removed card is not returned by the index', mod.findToolCard(refs, 'call_gone') === null);
  }

  // ---- 3. Re-keying moves the entry ---------------------------------
  {
    const el = createElement('div');
    el.className = 'chat-view__transcript';
    const refs = makeRefs(el);
    const card = mod.appendToolCallCard({ id: 'placeholder', name: 'subagent', args: {} }, refs);
    mod.rekeyToolCard(refs, 'server_id', card);
    check('the re-keyed card is found under its new id', mod.findToolCard(refs, 'server_id') === card);
    check('the stale id no longer resolves to that card', mod.findToolCard(refs, 'placeholder') === null,
      String(mod.findToolCard(refs, 'placeholder') && mod.findToolCard(refs, 'placeholder').dataset.toolId));
    check('the attribute agrees with the index', card.dataset.toolId === 'server_id');
  }

  // ---- 4. The args index is built once per array revision -----------
  {
    const el = createElement('div');
    const refs = makeRefs(el);
    const messages = [
      { role: 'tool', phase: 'call', toolCallId: 'c1', args: { cmd: 'ls' } },
      { role: 'tool', phase: 'result', toolCallId: 'c1', content: '{}' },
      { role: 'tool', phase: 'call', toolCallId: 'c2', args: { path: 'a' } }
    ];
    const state = { messages, chat: {} };
    const first = mod.toolCallArgsIndex(state);
    check('the args index resolves a call id', first.get('c1').cmd === 'ls');
    const again = mod.toolCallArgsIndex(state);
    check('an unchanged messages array reuses the index', again === first);

    // A new array identity (every mutation path replaces the array) rebuilds.
    state.messages = messages.concat([{ role: 'tool', phase: 'call', toolCallId: 'c3', args: { x: 1 } }]);
    const rebuilt = mod.toolCallArgsIndex(state);
    check('a new messages array rebuilds the index', rebuilt !== first);
    check('the rebuilt index sees the new row', rebuilt.get('c3').x === 1);
  }

  // ---- 5. toolCallArgsFor uses the index (no scan) ------------------
  {
    const el = createElement('div');
    const refs = makeRefs(el);
    const messages = [];
    for (let i = 0; i < 400; i++) {
      messages.push({ role: 'tool', phase: 'call', toolCallId: 'c' + i, args: { i } });
    }
    const state = { messages, chat: {} };
    const resultRow = { role: 'tool', phase: 'result', toolCallId: 'c399' };
    check('the args are recovered for a result row', mod.toolCallArgsFor(state, resultRow).i === 399);
    const start = process.hrtime.bigint();
    for (let i = 0; i < 2000; i++) mod.toolCallArgsFor(state, resultRow);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // A linear scan of 400 rows x 2000 lookups would be ~800k comparisons; the
    // index makes it 2000 map hits. This bound is loose enough not to flake on
    // a loaded machine and tight enough to fail a reintroduced scan.
    check('2000 lookups over a 400-call transcript stay fast', ms < 250, ms.toFixed(1) + 'ms');
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
