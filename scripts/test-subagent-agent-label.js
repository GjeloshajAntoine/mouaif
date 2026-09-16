'use strict';

// Regression test: a delegated run must name the agent it dispatched, and its
// nested transcript must be visible without a tap.
//
// Two defects are locked in here:
//
//   1. NOTHING NAMED THE AGENT. The subagent tool takes an optional `agent`
//      argument matched against the project's stored agent names, and the
//      server now echoes it back on the result (`result.agent`). The card,
//      however, rendered the generic "Subagent" header and a `system` role
//      label, so an `@reviewer` dispatch and a model-driven generic delegation
//      were byte-for-byte identical on screen — there was no way to tell which
//      agent answered after the fact. The head now carries a `.tool-card__agent`
//      chip and the nested system row's role label names the agent.
//
//   2. THE BODY WAS LAZY AND THE CARD COLLAPSED. `appendToolResultCard`
//      deferred the result body to first expand and left a successful subagent
//      card collapsed; the subagent transcript IS that body, so a finished run
//      rendered as a bare "Subagent · task · ok" row with nothing under it.
//      Subagent cards now build their body immediately and stay expanded.
//
// transcript.js is loaded the way scripts/test-subagent-transcript-parity.js
// loads it: the import block is stripped and the body runs in a VM whose
// globals auto-provide the module's helpers. The assertions are about the rows
// the renderer produces, not about source shape.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- DOM stub (same minimal element stub the parity test uses) --------

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
  let node2 = node.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (node2) {
      if (matchesSimple(node2, parts[i])) { found = true; node2 = node2.parentNode; break; }
      node2 = node2.parentNode;
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
    renderMarkdown: (s) => String(s || ''),
    coerceToolResult: (raw) => {
      if (typeof raw !== 'string') return raw;
      try { return JSON.parse(raw); } catch { return raw; }
    },
    normalizeToolName: (n) => n,
    isSubagentTool: (n) => n === 'subagent' || n === 'functions.subagent',
    formatToolArgs: (args, name) => {
      if (args && typeof args === 'object') return args.task || JSON.stringify(args);
      return String(args == null ? '' : args);
    },
    TOOL_ARGS_PREVIEW_CHARS: 220,
    formatResultSummary: () => null,
    isExpectedToolFailure: () => false,
    cssEscape: (s) => String(s == null ? '' : s).replace(/["\\]/g, '\\$&'),
    afterTranscriptAppend() {},
    scrollToolBodyToBottom() {},
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
    + ' this.agentLabel = agentLabel;', context);
  return context;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// A refs bag with a transcript the card builders can insert into.
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

function subagentResult(agent) {
  const result = {
    ok: true,
    text: 'All done.',
    model: { id: 'gpt-5-codex' },
    chat: [
      { role: 'system', content: [{ type: 'text', text: 'Find where features are.' }] },
      { role: 'user', content: 'Locate the composer.' },
      { role: 'assistant', content: 'All done.' }
    ]
  };
  if (agent) result.agent = agent;
  return result;
}

function main() {
  const mod = loadTranscript(installDom());

  // ---- agentLabel ---------------------------------------------------
  {
    check('an agent name becomes the row role label', mod.agentLabel('Search') === 'Search');
    check('a generic delegation falls back to "agent"',
      mod.agentLabel('') === 'agent' && mod.agentLabel(null) === 'agent' && mod.agentLabel('   ') === 'agent',
      JSON.stringify([mod.agentLabel(''), mod.agentLabel(null)]));
  }

  // ---- 1. The head names the agent ----------------------------------
  {
    const refs = makeRefs();
    mod.appendToolCallCard({ id: 'c1', name: 'subagent', args: { task: 'Locate the composer.', agent: 'Search' } }, refs);
    const card = refs.transcript.current.querySelector('.tool-card');
    check('the call card exists on the transcript', !!card);
    if (!card) { console.log('--- aborted ---'); process.exitCode = 1; return; }
    const chip = card.querySelector('.tool-card__agent');
    check('the chip shows the dispatched agent name', !!chip && chip.textContent === 'Search', chip && chip.textContent);
    check('the card still shows the generic label beside the chip',
      card.querySelector('.tool-card__name').textContent === 'Subagent',
      card.querySelector('.tool-card__name').textContent);
  }

  // ---- 2. A generic delegation shows NO chip --------------------------
  {
    const refs = makeRefs();
    mod.appendToolCallCard({ id: 'c1', name: 'subagent', args: { task: 'Locate the composer.' } }, refs);
    const card = refs.transcript.current.querySelector('.tool-card');
    check('a model-driven delegation adds no agent chip', !card.querySelector('.tool-card__agent'));
  }

  // ---- 3. The result path keeps the chip AND builds the body ---------
  {
    const refs = makeRefs();
    mod.appendToolResultCard({
      id: 'c1',
      name: 'subagent',
      ok: true,
      args: { task: 'Locate the composer.', agent: 'Search' },
      result: subagentResult('Search')
    }, refs);
    const card = refs.transcript.current.querySelector('.tool-card');
    const chip = card.querySelector('.tool-card__agent');
    check('the result card names the agent too', !!chip && chip.textContent === 'Search', chip && chip.textContent);
    check('a settled subagent card is expanded', card.classList.contains('is-expanded'), card.className);
    const wrap = card.querySelector('.tool-card__subagent-chat');
    check('the nested transcript is built immediately, not on first tap', !!wrap);
    check('the nested body is not left lazy',
      (card.querySelector('.tool-card__body') || {}).dataset
        ? !card.querySelector('.tool-card__body').dataset.lazyResult
        : false);
  }

  // ---- 4. The nested system row is labelled with the agent ----------
  {
    const refs = makeRefs();
    mod.appendToolResultCard({
      id: 'c1',
      name: 'subagent',
      ok: true,
      args: { task: 'Locate the composer.', agent: 'Search' },
      result: subagentResult('Search')
    }, refs);
    const card = refs.transcript.current.querySelector('.tool-card');
    const wrap = card && card.querySelector('.tool-card__subagent-chat');
    const sysRow = wrap && wrap.querySelector('.chat-msg--system');
    const role = sysRow && sysRow.querySelector('.chat-msg__role');
    check('the nested system row names the agent instead of "system"',
      !!role && role.textContent === 'Search', role && role.textContent);
  }

  // ---- 5. Without a name the nested row stays "agent" ---------------
  {
    const refs = makeRefs();
    mod.appendToolResultCard({
      id: 'c1',
      name: 'subagent',
      ok: true,
      result: subagentResult()
    }, refs);
    const card = refs.transcript.current.querySelector('.tool-card');
    const role = card.querySelector('.chat-msg--system .chat-msg__role');
    check('a generic delegation labels the nested system row "agent"',
      !!role && role.textContent === 'agent', role && role.textContent);
    check('a generic delegation still shows no chip', !card.querySelector('.tool-card__agent'));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

assert.ok(true);
main();
