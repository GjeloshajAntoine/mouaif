'use strict';

// Regression test: the transcript's header block keeps its order.
//
// The transcript lays out
//
//   [setup] [system prompt] [tools] [agent files] [skills] [empty state]
//
// above the message rows and any standing ask_user / authorization overlay
// card. Three separate bugs broke that order, all of them visible to the user
// as "the prompt and tool checkboxes sometimes appear in the middle":
//
//   1. Every header card mounter located its slot by looking up a sibling
//      anchor ("insert after the system-prompt row, else before the empty
//      state, else append"). Both anchors can legitimately be absent — the
//      system-prompt row is removed and re-inserted on every refresh, the
//      empty state goes with the first message — and the append fallback
//      dropped the card BELOW the conversation.
//
//   2. renderSystemPromptMessage() re-inserted its row "after the setup card
//      if mounted, else as the first child", so refreshing the prompt put the
//      system row back ABOVE the creation-time setup control.
//
//   3. isMessageRowNode() classified the system-prompt row as a message row.
//      It carries `.chat-msg` (it is a bubble) but is a header card and has no
//      row key, so reconcileTranscriptRows() (a) parked its row cursor on it
//      and inserted real messages ABOVE the header block, and (b) culled it as
//      an unkeyed row on the next pass whenever it was no longer first.
//
// headerCards.js and transcript.js are loaded the way the other transcript
// tests load them: the import block is stripped and the bodies run in a VM
// with a minimal element stub. The assertions are about the resulting child
// order, not about source shape — restore any of the three behaviours and the
// matching check fails.

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
    textContent: '',
    innerHTML: '',
    hidden: false,
    dataset: {},
    style: {},
    attributes: {},
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
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = node;
      node.children.push(child);
      node.childElementCount = node.children.length;
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = node;
      const at = ref == null ? -1 : node.children.indexOf(ref);
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
    get nextSibling() {
      if (!node.parentNode) return null;
      const sibs = node.parentNode.children;
      const i = sibs.indexOf(node);
      return i === -1 ? null : (sibs[i + 1] || null);
    },
    matches(selector) { return matchesSelector(node, selector); },
    querySelector(selector) { return findOne(node, selector); },
    querySelectorAll(selector) { return findAll(node, selector); },
    addEventListener() {},
    removeEventListener() {}
  };
  return node;
}

// Selector support is deliberately narrow — exactly the forms the header-card
// code uses: `.class`, `[data-attr]`, `[data-attr="v"]`, and `:not(...)`.
function parseSimple(part) {
  const spec = { classes: [], attrs: [], not: null, tag: null };
  let text = String(part).trim();
  const notMatch = /:not\(([^)]*)\)/.exec(text);
  if (notMatch) { spec.not = notMatch[1]; text = text.replace(notMatch[0], ''); }
  const tagMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(text);
  if (tagMatch) spec.tag = tagMatch[0].toUpperCase();
  const re = /\.([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) spec.classes.push(m[1]);
    else spec.attrs.push({ name: m[2], value: m[3] });
  }
  return spec;
}

function datasetKey(attrName) {
  const m = /^data-(.+)$/.exec(attrName);
  if (!m) return attrName;
  return m[1].replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function matchesSimple(node, spec) {
  if (!node || node.nodeType !== 1) return false;
  if (spec.tag && node.tagName !== spec.tag) return false;
  if (spec.not && matchesSelector(node, spec.not)) return false;
  for (const c of spec.classes) if (!node.classList.contains(c)) return false;
  for (const a of spec.attrs) {
    const key = datasetKey(a.name);
    const value = node.dataset ? node.dataset[key] : undefined;
    if (value === undefined) return false;
    if (a.value !== undefined && String(value) !== a.value) return false;
  }
  return true;
}

function matchesSelector(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  return String(selector).split(',').some((part) => matchesSimple(node, parseSimple(part)));
}

function findAll(root, selector) {
  const out = [];
  const walk = (el) => {
    for (const child of el.children) {
      if (matchesSelector(child, selector)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function findOne(root, selector) {
  return findAll(root, selector)[0] || null;
}

function installDom() {
  const frames = new Map();
  let nextId = 0;
  const raf = (fn) => { frames.set(++nextId, fn); return nextId; };
  const caf = (id) => { frames.delete(id); };
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = caf;
  return {
    frames,
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

function loadModule(relPath, globals, exportsSource) {
  const source = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
  const body = source
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  const base = Object.assign({
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
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
  vm.runInContext(body + ';' + exportsSource, context);
  return context;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// Describe a transcript's children as role tokens so a failure prints the
// actual order.
function order(el) {
  return el.children.map((child) => {
    const ds = child.dataset || {};
    if (child.classList.contains('chat-view__setup')) return 'setup';
    if (child.classList.contains('chat-view__empty')) return 'empty';
    if (ds.sysPrompt !== undefined) return 'system';
    if (ds.toolsCard !== undefined) return 'tools';
    if (ds.agentFilesCard !== undefined) return 'agentFiles';
    if (ds.skillsCard !== undefined) return 'skills';
    if (ds.authCallId !== undefined) return 'overlay';
    if (ds.live !== undefined) return 'live';
    if (child.classList.contains('chat-msg')) return 'msg:' + (child.textContent || '?');
    if (child.classList.contains('tool-card')) return 'tool:' + (ds.toolId || '?');
    return 'other';
  });
}

function card(cls, dataKey) {
  const el = createElement('div');
  el.className = cls;
  if (dataKey) el.dataset[dataKey] = '1';
  return el;
}

function makeRefs(el) {
  return {
    transcript: { current: el },
    setupCard: { current: null },
    toolsCard: { current: null },
    agentFilesCard: { current: null },
    skillsCard: { current: null },
    pinnedToBottom: { current: true },
    pendingCount: { current: 0 },
    jumpBtn: { current: null },
    usageSummary: { current: null },
    _insertAnchor: null,
    _pendingTranscriptChunk: null,
    _suspendScrollPin: false,
    _anonToolCalls: [],
    _autoresize() {}
  };
}

function main() {
  const dom = installDom();

  // headerCards.js is standalone; transcript.js supplies its own helpers from
  // the VM globals (the builders under test are the two below).
  let headerCards;
  try {
    headerCards = loadModule('frontend/src/components/chat/headerCards.js', dom.globals,
      'this.placeHeaderCard = placeHeaderCard; this.orderHeaderCards = orderHeaderCards;'
      + ' this.headerCardIndex = headerCardIndex; this.isHeaderCardNode = isHeaderCardNode;'
      + ' this.HEADER_CARD_ORDER = HEADER_CARD_ORDER;');
  } catch (err) {
    failed++;
    console.log('  FAIL - headerCards.js must be loadable standalone: ' + err.message);
    console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
    process.exitCode = 1;
    return;
  }

  const H = headerCards.HEADER_CARD_ORDER;

  // ---- 1. A card is placed in its slot even when every anchor is absent ---
  {
    const el = createElement('div');
    // A message row first, so "no header card mounted yet" is the case that
    // used to hit the appendChild fallback.
    const msg = createElement('div');
    msg.className = 'chat-msg chat-msg--user';
    msg.textContent = 'hi';
    el.appendChild(msg);

    const tools = card('chat-view__tools-card', 'toolsCard');
    headerCards.placeHeaderCard(el, tools, H.tools);
    check('the tools card lands above an existing message row, not below it',
      JSON.stringify(order(el)) === JSON.stringify(['tools', 'msg:hi']), JSON.stringify(order(el)));

    // The system-prompt row arrives afterwards (the refresh path) and must
    // take slot 1, above the tools card.
    const sys = card('chat-msg chat-msg--system');
    sys.dataset.sysPrompt = '1';
    headerCards.placeHeaderCard(el, sys, H.sysPrompt);
    check('a later system-prompt row takes its slot above tools',
      JSON.stringify(order(el)) === JSON.stringify(['system', 'tools', 'msg:hi']), JSON.stringify(order(el)));

    // Skills mounts last but belongs between tools and the messages.
    const skills = card('chat-view__skills-card', 'skillsCard');
    headerCards.placeHeaderCard(el, skills, H.skills);
    check('skills slots in above the messages',
      JSON.stringify(order(el)) === JSON.stringify(['system', 'tools', 'skills', 'msg:hi']), JSON.stringify(order(el)));

    // Agent files belongs between tools and skills, i.e. it must be inserted
    // mid-block rather than appended after skills.
    const af = card('chat-view__agent-files-card', 'agentFilesCard');
    headerCards.placeHeaderCard(el, af, H.agentFiles);
    check('agent files slots between tools and skills',
      JSON.stringify(order(el)) === JSON.stringify(['system', 'tools', 'agentFiles', 'skills', 'msg:hi']),
      JSON.stringify(order(el)));
  }

  // ---- 2. Re-placing a card that is already in its slot does not move it --
  {
    const el = createElement('div');
    const sys = card('chat-msg chat-msg--system');
    sys.dataset.sysPrompt = '1';
    const tools = card('chat-view__tools-card', 'toolsCard');
    const skills = card('chat-view__skills-card', 'skillsCard');
    headerCards.placeHeaderCard(el, sys, H.sysPrompt);
    headerCards.placeHeaderCard(el, tools, H.tools);
    headerCards.placeHeaderCard(el, skills, H.skills);
    const before = el.children.slice();
    let insertions = 0;
    const realInsert = el.insertBefore;
    el.insertBefore = function (child, ref) { insertions++; return realInsert.call(el, child, ref); };
    headerCards.orderHeaderCards(makeRefs(el));
    check('a settled header block is left untouched (no insert, so no replayed animation)',
      insertions === 0 && el.children.length === before.length
        && el.children.every((child, i) => child === before[i]),
      'insertions=' + insertions + ' ' + JSON.stringify(order(el)));
  }

  // ---- 3. The invariant pass repairs a mis-ordered block ---------------
  {
    const el = createElement('div');
    const tools = card('chat-view__tools-card', 'toolsCard');
    const sys = card('chat-msg chat-msg--system');
    sys.dataset.sysPrompt = '1';
    const af = card('chat-view__agent-files-card', 'agentFilesCard');
    const msg = createElement('div');
    msg.className = 'chat-msg chat-msg--user';
    msg.textContent = 'hi';
    // Exactly the damage the old anchor-guessing mounters produced: the system
    // row above everything, tools stranded below the conversation.
    el.appendChild(sys);
    el.appendChild(af);
    el.appendChild(msg);
    el.appendChild(tools);
    headerCards.orderHeaderCards(makeRefs(el));
    check('orderHeaderCards moves a stranded tools card back above the messages',
      JSON.stringify(order(el)) === JSON.stringify(['system', 'tools', 'agentFiles', 'msg:hi']),
      JSON.stringify(order(el)));
  }

  // ---- 4. The system-prompt row is not a message row -------------------
  {
    const sys = card('chat-msg chat-msg--system');
    sys.dataset.sysPrompt = '1';
    check('isHeaderCardNode() recognises the system-prompt row',
      headerCards.isHeaderCardNode(sys) === true);
    const plain = createElement('div');
    plain.className = 'chat-msg chat-msg--user';
    check('isHeaderCardNode() leaves a real message alone',
      headerCards.isHeaderCardNode(plain) === false);
  }

  // ---- 5. The reconciler treats the system-prompt row as a header card --
  //
  // The row is a `.chat-msg` bubble, so the reconciler used to see it as an
  // unkeyed message row: it parked the row cursor on it and inserted the real
  // messages ABOVE the header block, then culled the row (no `_rowKey`) on the
  // next pass. Both halves are pinned here.
  {
    const transcript = loadModule('frontend/src/components/chat/transcript.js',
      Object.assign({
        placeHeaderCard: headerCards.placeHeaderCard,
        orderHeaderCards: headerCards.orderHeaderCards,
        headerCardIndex: headerCards.headerCardIndex,
        isHeaderCardNode: headerCards.isHeaderCardNode,
        HEADER_CARD_ORDER: H
      }, dom.globals),
      'this.reconcileTranscriptRows = reconcileTranscriptRows; this.transcriptRowKey = transcriptRowKey;');
    const el2 = createElement('div');
    const refs = makeRefs(el2);
    const sys = card('chat-msg chat-msg--system');
    sys.dataset.sysPrompt = '1';
    const tools = card('chat-view__tools-card', 'toolsCard');
    const msg = createElement('div');
    msg.className = 'chat-msg chat-msg--user';
    msg.textContent = 'hi';
    el2.appendChild(sys);
    el2.appendChild(tools);
    el2.appendChild(msg);
    const messages = [{ role: 'user', content: 'hi', seq: 1 }];
    msg._rowKey = transcript.transcriptRowKey(messages[0]);
    const state = { messages, chat: {} };
    transcript.reconcileTranscriptRows(state, refs, [0]);
    check('reconcile keeps the messages below the header block',
      JSON.stringify(order(el2)) === JSON.stringify(['system', 'tools', 'msg:hi']),
      JSON.stringify(order(el2)));
    check('reconcile does not cull the system-prompt row',
      el2.children.indexOf(sys) !== -1, JSON.stringify(order(el2)));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();