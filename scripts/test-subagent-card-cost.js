'use strict';

// Regression test: a subagent card shows what THAT delegated run cost.
//
// Before: the server billed a delegated run per nested round and streamed each
// increment as `usage_update { source: 'subagent', cost }`, and the chat UI
// only folded the number into the chat-wide "Total" pill. The card that owned
// the work showed nothing, so a user watching a long subagent had no idea what
// it was costing until the chat total moved for unexplained reasons.
//
// Locked in here:
//   1. The server tags each delegated `usage_update` with the parent subagent
//      call id, and a settled result carries the run's own price.
//   2. The card head draws the running figure, and a frame without a call id
//      changes nothing (older server: Total-only behaviour preserved).
//   3. The figure survives the two renders that replace the head — the settle
//      path and a full transcript rebuild — instead of vanishing at the exact
//      moment the run ends.
//   4. A run whose price is not known draws NO label (never a confident
//      $0.00), and a label that is stale is cleared.
//
// transcript.js is loaded the way scripts/test-subagent-agent-label.js loads
// it: the import block is stripped and the body runs in a VM whose globals
// auto-provide the module's helpers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- minimal DOM stub ------------------------------------------------

function classListOf(node) {
  return String(node.className || '').split(/\s+/).filter(Boolean);
}

function matchesSimple(node, sel) {
  if (sel.startsWith('[')) {
    const m = sel.match(/^\[data-([\w-]+)="([^"]*)"\]$/);
    if (!m) return false;
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return String(node.dataset[key] == null ? '' : node.dataset[key]) === m[2];
  }
  if (!sel.includes('.')) return node.tagName === sel.toUpperCase();
  const wanted = sel.split('.').filter(Boolean);
  if (!wanted.length) return false;
  const have = classListOf(node);
  return wanted.every((c) => have.includes(c));
}

function matches(node, sel) {
  const parts = String(sel).trim().split(/\s+/);
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  let up = node.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (up) {
      if (matchesSimple(up, parts[i])) { found = true; up = up.parentNode; break; }
      up = up.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

function descendants(node, out) {
  out = out || [];
  for (const child of node.children) { out.push(child); descendants(child, out); }
  return out;
}

function createElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    className: '',
    textContent: '',
    hidden: false,
    title: '',
    dataset: {},
    style: {},
    childElementCount: 0,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 400,
    get classList() {
      const list = classListOf(node);
      return {
        add(c) { if (!list.includes(c)) list.push(c); node.className = list.join(' '); },
        remove(c) { const i = list.indexOf(c); if (i >= 0) list.splice(i, 1); node.className = list.join(' '); },
        contains(c) { return list.includes(c); },
        toggle(c) { if (list.includes(c)) list.splice(list.indexOf(c), 1); else list.push(c); node.className = list.join(' '); }
      };
    },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      node.childElementCount = node.children.length;
      return child;
    },
    insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child);
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
    querySelector(sel) { return descendants(node).find((n) => matches(n, sel)) || null; },
    querySelectorAll(sel) { return descendants(node).filter((n) => matches(n, sel)); },
    closest(sel) { let n = node; while (n) { if (matches(n, sel)) return n; n = n.parentNode; } return null; },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    matches(sel) { return matches(node, sel); }
  };
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get() { return html; },
    set(value) {
      html = value == null ? '' : String(value);
      for (const child of node.children) child.parentNode = null;
      node.children = [];
      node.childElementCount = 0;
    }
  });
  return node;
}

function installDom() {
  return {
    document: {
      createElement,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
}

// ---- module loader ---------------------------------------------------

function loadTranscript(globals) {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/transcript.js'), 'utf8');
  const body = source
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  const base = Object.assign({
    console,
    JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    // The real formatter's shape, not a stub: the assertions read the text on
    // the label, and a stub would pass whatever the renderer happened to write.
    formatCost: (n) => '$' + Number(n).toFixed(4),
    renderMarkdown: (s) => String(s || ''),
    coerceToolResult: (raw) => {
      if (typeof raw !== 'string') return raw;
      try { return JSON.parse(raw); } catch { return raw; }
    },
    normalizeToolName: (n) => String(n || '').replace(/^functions\./, ''),
    isSubagentTool: (n) => n === 'subagent' || n === 'functions.subagent',
    formatToolArgs: (args) => (args && typeof args === 'object' ? (args.task || JSON.stringify(args)) : String(args == null ? '' : args)),
    TOOL_ARGS_PREVIEW_CHARS: 220,
    formatResultSummary: () => null,
    isExpectedToolFailure: () => false,
    cssEscape: (s) => String(s == null ? '' : s).replace(/["\\]/g, '\\$&'),
    afterTranscriptAppend() {},
    scrollToolBodyToBottomSoon() {},
    cancelToolBodyScroll() {},
    updateUsageSummary() {},
    pinTranscriptAfterSettle() {},
    updateJumpButton() {},
    renderToolResultBody() {}
  }, globals);
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(body + ';'
    + ' this.appendToolCallCard = appendToolCallCard;'
    + ' this.appendToolResultCard = appendToolResultCard;'
    + ' this.renderSubagentChat = renderSubagentChat;'
    + ' this.setSubagentCardCost = setSubagentCardCost;'
    + ' this.rememberSubagentCardCost = rememberSubagentCardCost;'
    + ' this.handleSubagentStreamEvent = handleSubagentStreamEvent;'
    + ' this.snapshotExpandedState = snapshotExpandedState;'
    + ' this.restoreExpandedState = restoreExpandedState;', context);
  return context;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

function makeRefs() {
  const root = createElement('div');
  root.className = 'chat-view__transcript';
  return {
    transcript: { current: root },
    pinnedToBottom: { current: true },
    pendingCount: { current: 0 },
    setupCard: { current: null },
    _suspendScrollPin: false
  };
}

function subagentResult(extra) {
  return Object.assign({
    ok: true,
    text: 'All done.',
    model: { id: 'gpt-5-codex' },
    chat: [
      { role: 'user', content: 'Locate the composer.' },
      { role: 'assistant', content: 'All done.' }
    ]
  }, extra || {});
}

function main() {
  const mod = loadTranscript(installDom());

  // ---- 1. the running figure lands on the card head --------------------
  {
    const refs = makeRefs();
    mod.appendToolCallCard({ id: 'c1', name: 'subagent', args: { task: 'Research.' } }, refs);
    const card = refs.transcript.current.querySelector('.tool-card');
    check('the subagent call card exists', !!card);
    if (!card) { console.log('--- aborted ---'); process.exitCode = 1; return; }
    mod.setSubagentCardCost(card, 0.0025);
    const label = card.querySelector('.tool-card__head .tool-card__cost');
    check('a running delegated cost is drawn on the head', !!label && label.textContent === '$0.0025', label && label.textContent);
    check('the label sits next to the status dot',
      !!label && label.parentNode.querySelector('.tool-card__pill') != null);
    mod.setSubagentCardCost(card, 0.0042);
    check('a later frame replaces the figure in place',
      card.querySelectorAll('.tool-card__cost').length === 1
        && card.querySelector('.tool-card__cost').textContent === '$0.0042',
      card.querySelectorAll('.tool-card__cost').length + ' labels');
    check('the card property is the authority', mod.rememberSubagentCardCost(card) === 0.0042);
  }

  // ---- 2. an unknown price draws nothing -------------------------------
  {
    const refs = makeRefs();
    mod.appendToolCallCard({ id: 'c1', name: 'subagent', args: { task: 'Research.' } }, refs);
    const card = refs.transcript.current.querySelector('.tool-card');
    mod.setSubagentCardCost(card, null);
    check('an unknown cost adds no label', !card.querySelector('.tool-card__cost'));
    mod.setSubagentCardCost(card, 0.01);
    mod.setSubagentCardCost(card, null);
    check('a cleared cost removes a stale label',
      !card.querySelector('.tool-card__cost') && mod.rememberSubagentCardCost(card) === null);
    check('a price of zero is a real, shown price',
      (mod.setSubagentCardCost(card, 0), !!card.querySelector('.tool-card__cost')),
      'zero is known, not unknown');
  }

  // ---- 3. the figure survives the settle render ------------------------
  {
    const refs = makeRefs();
    mod.appendToolCallCard({ id: 'c1', name: 'subagent', args: { task: 'Research.' } }, refs);
    const card = refs.transcript.current.querySelector('.tool-card');
    mod.setSubagentCardCost(card, 0.0031);
    mod.appendToolResultCard({
      id: 'c1', name: 'subagent', ok: true,
      args: { task: 'Research.' },
      // No totalCost: the run's price is not known from the result, so the
      // running figure the user was watching must be carried over rather than
      // dropped when the head is rebuilt.
      result: subagentResult()
    }, refs);
    const label = card.querySelector('.tool-card__cost');
    check('the settle path re-draws the running cost on the fresh head',
      !!label && label.textContent === '$0.0031', label && label.textContent);
  }

  // ---- 4. a settled result with its own price wins ---------------------
  {
    const refs = makeRefs();
    mod.appendToolResultCard({
      id: 'c1', name: 'subagent', ok: true,
      args: { task: 'Research.' },
      result: subagentResult({ totalCost: 0.0187 })
    }, refs);
    const card = refs.transcript.current.querySelector('.tool-card');
    const label = card.querySelector('.tool-card__cost');
    check('a settled run shows its own resolved price',
      !!label && label.textContent === '$0.0187', label && label.textContent);
    check('the figure is remembered for the next render', mod.rememberSubagentCardCost(card) === 0.0187);
  }

  // ---- 5. the live nested result keeps the card current ----------------
  {
    const refs = makeRefs();
    mod.appendToolCallCard({ id: 'c1', name: 'subagent', args: { task: 'Research.' } }, refs);
    const card = refs.transcript.current.querySelector('.tool-card');
    mod.handleSubagentStreamEvent({ eventName: 'tool_result' }, {
      parentCallId: 'c1', id: 'n1', name: 'subagent', ok: true,
      result: { ok: true, totalCost: 0.0065, text: 'done' }
    }, refs);
    const label = card.querySelector('.tool-card__cost');
    check('a live nested result updates the parent card cost',
      !!label && label.textContent === '$0.0065', label && label.textContent);
  }

  // ---- 6. a failed run still reports what it cost ----------------------
  {
    const refs = makeRefs();
    mod.appendToolResultCard({
      id: 'c1', name: 'subagent', ok: false,
      args: { task: 'Research.' },
      // A failure carries no transcript (no chat, no text), so the render
      // returns early — the cost must already be on the head by then, or a
      // run that burned tokens and then died would show nothing at all.
      result: { ok: false, totalCost: 0.0091, error: { code: 'ESUBAGENT', message: 'boom' } }
    }, refs);
    const card = refs.transcript.current.querySelector('.tool-card');
    const label = card.querySelector('.tool-card__cost');
    check('a failed run with no transcript still shows its cost',
      !!label && label.textContent === '$0.0091', label && label.textContent);
  }

  // ---- 7. the frame the server sends names the card ---------------------
  {
    const source = fs.readFileSync(path.join(__dirname, '../src/ai-stream.js'), 'utf8');
    const report = source.slice(source.indexOf('function reportDelegatedUsage('), source.indexOf('function toolResultImageParts('));
    check('a delegated usage_update carries the parent call id',
      /onEvent\('usage_update',[\s\S]*callId: report\.callId/.test(report),
      'usage_update is emitted without callId, so no card can be labelled');
    // The delegated subagent's round report and its completion report are the
    // two places that hand a call id up from the nested run.
    const forwarded = (source.match(/callId: \(callOpts && callOpts\.callId\) \|\| undefined/g) || []).length;
    check('the round and completion reports both pass a call id', forwarded === 2, String(forwarded));

    const stream = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/stream.js'), 'utf8');
    check('the chat routes a call-id-tagged frame to that card',
      /data\.callId[\s\S]{0,260}setSubagentCardCost/.test(stream),
      'stream.js never attributes the update to a card');
  }

  {
    const refs = makeRefs();
    mod.appendToolCallCard({ id: 'replay', name: 'subagent', args: { task: 'Review' } }, refs);
    const frame = { parentCallId: 'replay', totalCost: 0.0123 };
    mod.handleSubagentStreamEvent({ eventName: 'usage_update' }, frame, refs);
    mod.handleSubagentStreamEvent({ eventName: 'usage_update' }, frame, refs);
    const card = refs.transcript.current.querySelector('.tool-card--subagent');
    check('replayed absolute costs do not double count', card._subagentCost === 0.0123);
    check('the returning tab sees the cost on the head', card.querySelector('.tool-card__cost').textContent === '$0.0123');
    const start = { parentCallId: 'replay', chat: [{ role: 'system', content: 'LIVE_PROMPT' }] };
    mod.handleSubagentStreamEvent({ eventName: 'start' }, start, refs);
    const snapshot = mod.snapshotExpandedState(refs.transcript.current);
    const rebuilt = makeRefs();
    mod.appendToolCallCard({ id: 'replay', name: 'subagent', args: { task: 'Review' } }, rebuilt);
    mod.restoreExpandedState(snapshot, rebuilt.transcript.current);
    const restored = rebuilt.transcript.current.querySelector('.tool-card--subagent');
    check('a transcript rebuild retains in-flight delegated cost', restored._subagentCost === 0.0123);
    check('a transcript rebuild retains the live prompt', restored.querySelector('.chat-msg__system-body').textContent === 'LIVE_PROMPT');
    mod.setSubagentCardCost(restored, 0.025);
    mod.restoreExpandedState(snapshot, rebuilt.transcript.current);
    check('a fresh settled cost wins over the old live snapshot', restored._subagentCost === 0.025);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

assert.ok(true);
main();
