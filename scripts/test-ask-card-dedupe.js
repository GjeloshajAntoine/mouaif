'use strict';
// Regression test: one ask_user question, one card.
//
// The ask_user question is shown by an overlay card that lives outside the
// message flow (mounted from the LIVE `ask_user_required` frame, the follower
// live stream, and the pending-auth poll). That card only removes itself when
// the answer is submitted from *this* tab. Answer from the OS notification or
// from a second tab and this tab never sees the click, so it stays on screen —
// and then the call's own `tool_call` frame arrives and appended a SECOND card
// under the same tool id. Two visible symptoms followed:
//
//   * the same question was rendered twice, and
//   * the `tool_result` frame was folded into the first match in DOM order
//     (the overlay card), so the transcript showed a bare JSON "Question"
//     card stuck on "running" next to the real answer.
//
// Two fixes are pinned here:
//   1. appendToolCallCard() drops a standing overlay card for the same call id
//      before appending the call card (transcript.js), and
//   2. removePendingAuthorizationCards() — the chat's "Stop" path — drops
//      ask_user cards as well as authorization cards (cards.js).
//
// Both modules are loaded the way scripts/test-tool-call-id-matching.js loads
// transcript.js: the import block is stripped and the body runs in a VM whose
// globals supply the module helpers, with a DOM stub that understands the
// class + data-attribute selectors the overlay de-dupe uses. Remove either fix
// and this test fails with two cards instead of one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- DOM stub --------------------------------------------------------
//
// Minimal element tree. Selector support is deliberately narrow: the compound
// `.class[data-attr]` / `.class[data-attr="v"]` / `[data-attr="v"]` forms the
// card code actually uses, optionally as a comma-separated list.
function parseSelector(selector) {
  return String(selector).split(',').map((part) => {
    const spec = { classes: [], attrs: [] };
    const re = /\.([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]/g;
    let m;
    while ((m = re.exec(part)) !== null) {
      if (m[1]) spec.classes.push(m[1]);
      else spec.attrs.push({ name: m[2], value: m[3] });
    }
    return spec;
  });
}

// `data-auth-call-id` in a selector is `dataset.authCallId` on the element:
// the DOM reflects data-* attributes into camelCase dataset keys.
function datasetKey(attrName) {
  const m = /^data-(.+)$/.exec(attrName);
  if (!m) return attrName;
  return m[1].replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function matchesSelector(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  return parseSelector(selector).some((spec) => {
    if (!node.matches || !node._matchSpec) return false;
    return node._matchSpec(spec);
  });
}

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
    replaceChild(next, prev) {
    const i = node.children.indexOf(prev);
    if (i >= 0) {
      node.children[i] = next;
      next.parentNode = node;
      prev.parentNode = null;
    }
    return prev;
    },
    get firstChild() { return node.children[0] || null; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    attrs: {},
    setAttribute(name, value) {
    node.attrs[name] = String(value);
    const key = datasetKey(name);
    if (key !== name) node.dataset[key] = String(value);
    },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null; },
    removeAttribute(name) { delete node.attrs[name]; },
    closest(selector) {
      let n = node.parentNode;
      while (n) {
        if (matchesSelector(n, selector)) return n;
        n = n.parentNode;
      }
      return null;
    },
    matches(selector) { return matchesSelector(node, selector); },
    _matchSpec(spec) {
    for (const c of spec.classes) if (!classes.has(c)) return false;
    for (const a of spec.attrs) {
      const key = datasetKey(a.name);
      const fromDataset = node.dataset ? node.dataset[key] : undefined;
      const value = fromDataset !== undefined ? fromDataset : node.attrs[a.name];
      if (value === undefined || value === null || value === '') return false;
      if (a.value !== undefined && String(value) !== a.value) return false;
    }
    return true;
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (matchesSelector(c, selector)) out.push(c);
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
  const raf = () => 1;
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = () => {};
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
      cancelAnimationFrame: () => {},
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    },
    requestAnimationFrame: raf,
    cancelAnimationFrame: () => {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
}

// ---- Module loader ---------------------------------------------------
//
// `tools.js` is pure (no imports, no DOM), so the real `isExpectedToolFailure`
// is loaded through a data: URL rather than re-implemented here. A copy would
// agree with itself and hide a regression in the predicate.
function realIsExpectedToolFailure() {
  const source = fs.readFileSync(
    path.join(__dirname, '../frontend/src/components/chat/tools.js'), 'utf8')
    .replace(/^export /gm, '');
  const context = { console, JSON, Math, String, Boolean, Array, Object, Number };
  // `typeof` keeps a tools.js without the predicate from throwing a
  // ReferenceError, so the message below is what the run reports.
  const mod = vm.runInNewContext(
    source + '; ({ isExpectedToolFailure: typeof isExpectedToolFailure === "function" ? isExpectedToolFailure : undefined })',
    context);
  if (typeof mod.isExpectedToolFailure !== 'function') {
    throw new Error('frontend/src/components/chat/tools.js exports no isExpectedToolFailure: '
      + 'a non-ok ask_user result (a dismissed question) cannot be told apart from a failure, '
      + 'so the collapsed card reports it as an error.');
  }
  return mod.isExpectedToolFailure;
}

function loadModule(file, exportsList, globals) {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/', file), 'utf8');
  const body = source
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  const base = Object.assign({
    console,
    JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    // Real behaviour for the helpers the assertions depend on.
    normalizeToolName: (name) => String(name || '').replace(/^functions\./, ''),
    cssEscape: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, (c) => '\\' + c),
    isSubagentTool: (name) => String(name || '').replace(/^functions\./, '') === 'subagent',
    coerceToolResult: (result) => (result && typeof result === 'object' ? result : { text: String(result || '') }),
    formatResultSummary: () => 'summary',
    // The real predicate, not a stub: whether a non-ok result still gets a
    // summary is exactly what this file's dismissal case asserts, and a stub
    // would pass whatever transcript.js did with it.
    isExpectedToolFailure: realIsExpectedToolFailure(),
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
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(
    body + '; ' + exportsList.map((name) => 'this.' + name + ' = ' + name + ';').join(' '),
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

// summaryOf(card) -> string | null
//
// The collapsed card's trailing slot, as the DOM stub exposes it. Mirrors the
// `.tool-card__result-summary` lookup the transcript code performs.
function summaryOf(card) {
  if (!card || !card._root) { /* the stub keeps children on every node */ }
  const found = (card.querySelectorAll ? card.querySelectorAll('.tool-card__result-summary') : []);
  const el = found && found[0];
  return el && el.textContent ? el.textContent : null;
}

// mountOverlayCard() is not under test here (it defers through
// whenTranscriptSettled); the card it hands to askUserCard() is what matters,
// so the stub mounts the same markup directly into the same transcript.
function mountAskOverlay(el, callId) {
  const card = createElement('div');
  card.className = 'tool-card tool-card--ask-user';
  card.dataset.authCallId = callId;
  card.dataset.toolId = callId;
  return el.appendChild(card);
}

const ASK_ARGS = {
  question: 'Which branch should the release be cut from?',
  options: [{ label: 'main', value: 'main' }, { label: 'trunk', value: 'trunk' }],
  multiSelect: false
};
const ASK_RESULT = {
  answered: true, choice: 'main', extra: '',
  options: [{ label: 'main', value: 'main' }, { label: 'trunk', value: 'trunk' }],
  multiSelect: false, cancelled: false
};

function main() {
  const globals = installDom();
  const transcript = loadModule('transcript.js', ['appendToolCallCard', 'appendToolResultCard'], globals);
  const cards = loadModule('cards.js', ['removePendingAuthorizationCards'], globals);

  // ---- 1. the call frame supersedes the standing question card -----
  {
    const el = createElement('div');
    el._root = true;
    const refs = makeRefs(el);
    mountAskOverlay(el, 'call_ask_1');
    check('the question card is mounted', toolCards(el).length === 1);

    transcript.appendToolCallCard({ id: 'call_ask_1', name: 'ask_user', args: ASK_ARGS }, refs);
    check('the call frame does not leave two cards for one question',
      toolCards(el).length === 1, 'cards=' + toolCards(el).length);
    check('the surviving card is the tool call card',
      toolCards(el)[0].classList.contains('tool-card--call')
      && !toolCards(el)[0].classList.contains('tool-card--ask-user'));

    transcript.appendToolResultCard({ id: 'call_ask_1', name: 'ask_user', ok: true, result: ASK_RESULT }, refs);
    check('the result updates that card instead of appending another',
      toolCards(el).length === 1, 'cards=' + toolCards(el).length);
    check('no card is left behind on "running"',
      toolCards(el)[0].classList.contains('tool-card--result')
      && !toolCards(el)[0].classList.contains('tool-card--call'));
  }

  // ---- 1b. a dismissed question reports the dismissal ----------------
  //
  // The runner answers Dismiss with `ok: false` and `cancelled: true`
  // (src/tools/ask.js buildResult), so both call sites suppressed the
  // summary and the card read as a plain red error. `formatResultSummary`
  // has reported this result as `dismissed` since the same commit that added
  // the summary; nothing reached it. The stub above returns a fixed string
  // for the formatter, so what is pinned here is the GATE: a non-ok result
  // the user chose must still be summarised, an error must not be.
  {
    const el = createElement('div');
    el._root = true;
    const refs = makeRefs(el);
    const DISMISSED = {
      answered: false, choice: '', extra: '',
      options: [{ label: 'main', value: 'main' }],
      multiSelect: false, cancelled: true
    };
    transcript.appendToolCallCard({ id: 'call_dis', name: 'ask_user', args: ASK_ARGS }, refs);
    transcript.appendToolResultCard({ id: 'call_dis', name: 'ask_user', ok: false, result: DISMISSED }, refs);
    check('a dismissed question is summarised, not left as a bare error',
      summaryOf(toolCards(el)[0]) === 'summary', 'summary=' + summaryOf(toolCards(el)[0]));

    const el2 = createElement('div');
    el2._root = true;
    const refs2 = makeRefs(el2);
    transcript.appendToolCallCard({ id: 'call_err', name: 'ask_user', args: ASK_ARGS }, refs2);
    transcript.appendToolResultCard({
      id: 'call_err', name: 'ask_user', ok: false,
      result: { error: { code: 'EBADINPUT', message: 'options required' } }
    }, refs2);
    check('a real failure still shows no summary',
      summaryOf(toolCards(el2)[0]) === null, 'summary=' + summaryOf(toolCards(el2)[0]));

    const el3 = createElement('div');
    el3._root = true;
    const refs3 = makeRefs(el3);
    transcript.appendToolCallCard({ id: 'call_sh', name: 'shell', args: { cmd: 'false' } }, refs3);
    transcript.appendToolResultCard({
      id: 'call_sh', name: 'shell', ok: false, result: { exitCode: 1, stderr: 'boom' }
    }, refs3);
    check("another tool's failure is unaffected",
      summaryOf(toolCards(el3)[0]) === null, 'summary=' + summaryOf(toolCards(el3)[0]));
  }

  // ---- 2. an unrelated call does not touch a standing question -----
  {
    const el = createElement('div');
    el._root = true;
    const refs = makeRefs(el);
    mountAskOverlay(el, 'call_ask_1');
    transcript.appendToolCallCard({ id: 'call_shell_1', name: 'shell', args: { cmd: 'ls' } }, refs);
    check('a different call id leaves the question card alone',
      toolCards(el).length === 2
      && toolCards(el).some((c) => c.classList.contains('tool-card--ask-user')));
  }

  // ---- 3. Stop drops every prompt card the chat is parked on -------
  {
    const el = createElement('div');
    el._root = true;
    const refs = makeRefs(el);
    mountAskOverlay(el, 'call_ask_1');
    const auth = createElement('div');
    auth.className = 'tool-card tool-card--authorization';
    auth.dataset.authCallId = 'call_shell_1';
    el.appendChild(auth);
    transcript.appendToolCallCard({ id: 'call_result_1', name: 'shell', args: { cmd: 'ls' } }, refs);

    cards.removePendingAuthorizationCards(refs);
    const left = toolCards(el);
    check('the ask_user card is removed by cancel',
      !left.some((c) => c.classList.contains('tool-card--ask-user')), 'cards=' + left.length);
    check('the authorization card is removed by cancel',
      !left.some((c) => c.classList.contains('tool-card--authorization')), 'cards=' + left.length);
    check('a settled tool card survives the cancel', left.length === 1);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  assert.ok(false, error && error.stack);
}
