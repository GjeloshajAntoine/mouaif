'use strict';

// Regression test: the nested subagent transcript must render as chat rows.
//
// renderSubagentChat() rebuilt the delegated conversation with its own row
// markup: no `.chat-msg__head`, no timestamp element, a bare "assistant" role
// label, and the system turn dumped as `JSON.stringify(content)` because a
// nested system message carries an array of typed content parts instead of the
// string a top-level message carries. Paired with
// `.tool-card__subagent-msg { align-self: stretch }` and the accent-soft user
// bubble overrides in tool-cards.css, the expanded subagent card read as a
// different component than the transcript it lives in.
//
// transcript.js is loaded the way the other transcript tests load it: the
// import block is stripped and the body is executed in a VM whose globals
// auto-provide the module's helpers. The assertions are about the rows the
// renderer produces, not about source shape.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- DOM stub --------------------------------------------------------

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
  // A bare selector is a tag name; the renderer only needs `summary`/`details`.
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
    removeEventListener() {}
  };
  // `body.innerHTML = ''` is the chat renderer's "clear this host" idiom;
  // the stub has to drop children for it or re-renders stack copies.
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
    JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    // The paths under test only care about the rows this module builds, so
    // the imported helpers are reduced to identity passthroughs.
    renderMarkdown: (s) => String(s || ''),
    coerceToolResult: (raw) => raw,
    normalizeToolName: (n) => n,
    isSubagentTool: () => true,
    afterTranscriptAppend() {},
    scrollToolBodyToBottom() {},
    updateUsageSummary() {},
    pinTranscriptAfterSettle() {},
    updateJumpButton() {},
    import_meta: undefined
  }, globals);
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(body + '; this.renderSubagentChat = renderSubagentChat; this.handleSubagentStreamEvent = handleSubagentStreamEvent;', context);
  return context;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

function makeCard() {
  const card = createElement('div');
  card.className = 'tool-card tool-card--call tool-card--result tool-card--subagent is-expanded';
  card.dataset.toolId = 'call_1';
  const body = createElement('div');
  body.className = 'tool-card__body';
  card.appendChild(body);
  return card;
}

function chatRows(wrap) {
  return wrap.children.filter((c) => classListOf(c).includes('chat-msg'));
}

function nestedToolRows(wrap) {
  return wrap.children.filter((c) => classListOf(c).includes('tool-card__subagent-tool'));
}

function headLabel(row) {
  const head = row.querySelector('.chat-msg__head');
  if (!head) return null;
  const role = head.querySelector('.chat-msg__role');
  const ts = head.querySelector('.chat-msg__ts');
  return { role: role && role.textContent, hasTs: !!ts, tsHidden: !!(ts && ts.hidden) };
}

function assistantText(row) {
  const answer = row.querySelector('.chat-msg__answer');
  // Final renders put markdown HTML in `innerHTML`; streaming renders put the
  // raw text in `textContent`.
  return answer ? (answer.innerHTML || answer.textContent) : null;
}

// A result payload shaped like the one src/ai-stream.js builds for a
// subagent call: system (content parts), user task, assistant turn, tool
// turn, and the final assistant answer.
function subagentResult(extra) {
  return Object.assign({
    ok: true,
    text: 'All done.',
    model: { id: 'gpt-5-codex' },
    chat: [
      { role: 'system', content: [{ type: 'text', text: 'You are a focused subagent. Answer only the delegated task.' }] },
      { role: 'user', content: 'Read src/index.js and report the port.' },
      { role: 'assistant', content: 'Checking the port.' },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: '{"ok":true,"text":"const PORT = 5732"}' },
      { role: 'assistant', content: 'All done.' }
    ]
  }, extra || {});
}

function main() {
  const mod = loadTranscript(installDom());

  // ---- 1. Every nested turn is a real chat row ----------------------
  {
    const card = makeCard();
    mod.renderSubagentChat(card, { name: 'subagent', result: subagentResult() });
    const wrap = card.querySelector('.tool-card__subagent-chat');
    check('the nested chat mounts inside the card body', !!wrap);

    const rows = chatRows(wrap);
    check('user, assistant and system turns render as chat rows', rows.length === 4, 'rows=' + rows.length);
    check('every nested chat row carries the subagent marker class',
      chatRows(wrap).every((r) => classListOf(r).includes('tool-card__subagent-msg')),
      chatRows(wrap).map((r) => r.className).join(' | '));

    const user = rows.find((r) => classListOf(r).includes('chat-msg--user'));
    const assistant = rows.filter((r) => classListOf(r).includes('chat-msg--assistant'));
    const system = rows.find((r) => classListOf(r).includes('chat-msg--system'));

    // ---- 2. Head + role label match appendMessageToTranscript --------
    check('the user row has the shared head/role/timestamp shape',
      JSON.stringify(headLabel(user)) === JSON.stringify({ role: 'user', hasTs: true, tsHidden: true }),
      JSON.stringify(headLabel(user)));
    check('nested assistant rows carry the head and the delegated model id',
      assistant.length === 2 && assistant.every((r) => {
        const h = headLabel(r);
        return h && h.role === 'gpt-5-codex' && h.hasTs && h.tsHidden;
      }),
      assistant.map((r) => JSON.stringify(headLabel(r))).join(' | '));
    check('the assistant answer renders through the chat answer container',
      assistantText(assistant[1]) === 'All done.', String(assistantText(assistant[1])));

    // ---- 3. A system turn is a system card, not a JSON dump ----------
    const details = system && system.querySelector('.chat-msg__system-details');
    const summary = details && details.querySelector('summary');
    check('the nested system prompt renders as the collapsed system card',
      !!details && !!summary && summary.textContent === 'System prompt · 1 line',
      summary && summary.textContent);
    check('the nested system text is the prompt body, not serialized parts',
      !!details && details.querySelector('.chat-msg__system-body').textContent === 'You are a focused subagent. Answer only the delegated task.',
      details && details.querySelector('.chat-msg__system-body').textContent);

    // ---- 4. Tool turns stay compact rows -----------------------------
    check('the tool turn renders as a nested tool row, not a bubble',
      nestedToolRows(wrap).length === 1 && chatRows(wrap).length === 4,
      'tools=' + nestedToolRows(wrap).length + ' chats=' + chatRows(wrap).length);
  }

  // ---- 5. No nested model id falls back to the bare role ------------
  {
    const card = makeCard();
    const result = subagentResult({ model: null });
    mod.renderSubagentChat(card, { name: 'subagent', result });
    const wrap = card.querySelector('.tool-card__subagent-chat');
    const assistant = chatRows(wrap).filter((r) => classListOf(r).includes('chat-msg--assistant'));
    check('an unknown delegated model labels the turn "assistant"',
    assistant.length === 2 && assistant.every((r) => { const h = headLabel(r); return h && h.role === 'assistant'; }),
    assistant.map((r) => (headLabel(r) || {}).role).join(' | '));
  }

  // ---- 6. A string-content chat still renders (direct @-mention) ----
  {
    const card = makeCard();
    mod.renderSubagentChat(card, { name: 'subagent', result: { ok: true, text: 'Answer text.' } });
    const wrap = card.querySelector('.tool-card__subagent-chat');
    const rows = chatRows(wrap);
    check('a result without a chat transcript renders its text in an assistant row',
      rows.length === 1 && classListOf(rows[0]).includes('chat-msg--assistant') && assistantText(rows[0]) === 'Answer text.',
      rows.map((r) => r.className + ':' + assistantText(r)).join(' | '));
  }

  // ---- 7. Live deltas stream into the same assistant bubble ---------
  {
    const card = makeCard();
    const transcript = createElement('div');
    transcript.className = 'chat-view__transcript';
    transcript.appendChild(card);
    const refs = { transcript: { current: transcript } };

    mod.handleSubagentStreamEvent({ eventName: 'message' }, { parentCallId: null, delta: 'Work' }, refs);
    mod.handleSubagentStreamEvent({ eventName: 'message' }, { parentCallId: null, delta: 'ing…' }, refs);

    const live = card.querySelector('.tool-card__subagent-live');
    const rows = live ? live.querySelectorAll('.tool-card__subagent-live-msg') : [];
    check('live text streams into a single chat bubble',
      rows.length === 1 && classListOf(rows[0]).includes('chat-msg--assistant') && classListOf(rows[0]).includes('tool-card__subagent-msg'),
      rows.map((r) => r.className).join(' | '));
    check('the bubble accumulates the deltas',
      rows.length === 1 && rows[0].querySelector('.chat-msg__answer').textContent === 'Working…',
      rows.length === 1 && rows[0].querySelector('.chat-msg__answer').textContent);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
