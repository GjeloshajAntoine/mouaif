// Unit test for the per-message Copy action in the chat transcript.
//
// Two halves:
//   1. messageCopyText (frontend/src/components/chat/utils.js) is pure, so it
//      is imported and exercised directly. It decides WHAT a row copies — in
//      particular that an assistant turn with both reasoning and an answer
//      copies only the answer, and that a reasoning-only turn is not empty.
//   2. appendMessageToTranscript (frontend/src/components/chat/transcript.js)
//      is imperative DOM, so transcript.js + tools.js + toolRender.js are
//      loaded the way the sibling transcript tests load them: the import block
//      is stripped and the body runs in a VM whose globals supply the module
//      helpers. The test then checks that a user/assistant row carries a
//      `.chat-msg__copy` button and that a system/error row does not.

'use strict';

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

// ---- Minimal DOM used by the imperative transcript renderer ----------

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
    attributes: {},
    _listeners: {},
    classList: {
      add(...names) { for (const n of names) classes.add(n); },
      remove(...names) { for (const n of names) classes.delete(n); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      }
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
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null; },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
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
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    matches(selector) { return matchesSelector(node, selector); },
    closest(selector) {
      let cur = node.parentNode;
      while (cur) {
        if (matchesSelector(cur, selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    querySelector(selector) { return querySelector(node, selector)[0] || null; },
    querySelectorAll(selector) { return querySelector(node, selector); },
    addEventListener(type, fn) { (node._listeners[type] = node._listeners[type] || []).push(fn); },
    removeEventListener() {}
  };
  return node;
}

function matchesSelector(node, selector) {
  const sel = String(selector).trim();
  if (sel.startsWith(':scope > ')) return false;
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const inner = sel.slice(1, -1);
    const eq = inner.indexOf('=');
    const name = (eq === -1 ? inner : inner.slice(0, eq)).trim();
    const raw = eq === -1 ? null : inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    const value = node.dataset[camelAttr(name)];
    return raw == null ? value != null : value === raw;
  }
  return node.tagName === sel.toUpperCase();
}

function querySelector(root, selector) {
  const sel = String(selector).trim();
  const direct = sel.startsWith(':scope > ');
  const target = direct ? sel.slice(':scope > '.length) : sel;
  const out = [];
  const visit = (node, depth) => {
    for (const child of node.children) {
      if (matchesSelector(child, target) && (!direct || depth === 0)) out.push(child);
      if (!direct || depth === 0) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

function installContext(utils) {
  const base = {
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    document: {
      createElement: makeNode,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    cssEscape: (value) => String(value),
    publishWebPreview() {},
    // messageCopyText is pure and already imported for the first half of the
    // test, so the transcript gets the real one. copyText is stubbed so a
    // click can be exercised without a real clipboard; the recorded value
    // lives on `copyState` (a plain object), because the context Proxy turns
    // unknown global reads into stubs.
    messageCopyText: utils.messageCopyText,
    copyState: { text: null },
    copyText: async (text) => { base.copyState.text = String(text); return true; }
  };
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  const load = (file) => {
    const source = fs.readFileSync(path.join(CHAT_DIR, file), 'utf8')
      .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
      .replace(/^export /gm, '');
    vm.runInContext(source, context, { filename: file });
  };
  load('tools.js');
  load('toolRender.js');
  const transcript = fs.readFileSync(path.join(CHAT_DIR, 'transcript.js'), 'utf8')
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  vm.runInContext(
    transcript + '; this.appendMessageToTranscript = appendMessageToTranscript; this.appendErrorCard = appendErrorCard;',
    context,
    { filename: 'transcript.js' }
  );
  return context;
}

function makeRefs() {
  const transcript = makeNode('div');
  transcript.className = 'chat-view__transcript';
  return {
    transcript: { current: transcript },
    pinnedToBottom: { current: true },
    _insertAnchor: null,
    _suspendScrollPin: false,
    _lastInsertedRow: null
  };
}

async function openUtils() {
  // Real copyText/messageCopyText from utils.js. The file is a plain ESM
  // module with no DOM import at module scope, so it can be imported whole.
  return import('../frontend/src/components/chat/utils.js');
}

async function main() {
  // ---- 1. What a message copies ------------------------------------
  const utils = await openUtils();
  const { messageCopyText } = utils;

  check('a user turn copies its prose',
    messageCopyText({ role: 'user', content: 'hello there' }) === 'hello there');
  check('an assistant answer copies without its reasoning',
    messageCopyText({ role: 'assistant', content: 'The answer.', reasoning: 'Step 1\nStep 2' }) === 'The answer.');
  check('a reasoning-only assistant turn is not empty',
    messageCopyText({ role: 'assistant', content: '', reasoning: 'only thinking' }) === 'only thinking');
  check('a missing message copies an empty string, never "undefined"',
    messageCopyText(null) === '' && messageCopyText(undefined) === '');
  const withImage = messageCopyText({
    role: 'user', content: 'look at this',
    attachments: [{ name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' }]
  });
  check('an image attachment is noted by name, not by data URL',
    /^look at this\n\n\[image: shot\.png\]$/.test(withImage), withImage);
  check('the data URL never reaches the clipboard',
    !/base64/.test(withImage), withImage);

  // ---- 2. The row carries the button --------------------------------
  const mod = installContext(utils);

  {
    const refs = makeRefs();
    const state = { chat: { modelId: 'gpt-x' }, messages: [] };
    mod.appendMessageToTranscript({ role: 'user', content: 'hi', ts: new Date().toISOString() }, false, refs, state);
    const row = refs.transcript.current.children[0];
    const btn = row.querySelector('.chat-msg__copy');
    check('a user row mounts a copy button', !!btn);
    check('the copy button sits in the row actions block',
      !!btn && btn.parentNode.className === 'chat-msg__actions', btn ? btn.parentNode.className : 'missing');
    check('the copy button is a real button with an accessible name',
      !!btn && btn.tagName === 'BUTTON' && btn.getAttribute('aria-label') === 'Copy message');
    // Icon-only: the glyph carries the control, the name travels on
    // aria-label. A stray text label would push the bubble's width around on a
    // 360px screen, which is what this control was changed to avoid.
    check('the copy button is icon-only, with no text label',
      !!btn && btn.textContent === '' && !/[a-z]/i.test(String(btn.innerHTML || '').replace(/<[^>]*>/g, '')),
      btn ? JSON.stringify(btn.textContent) : 'missing');
    check('the copy button starts as a clipboard glyph',
      !!btn && /<svg/.test(String(btn.innerHTML)) && /<rect/.test(String(btn.innerHTML)),
      btn ? String(btn.innerHTML) : 'missing');
    check('the copy glyph inherits its color instead of hard-coding a fill',
      !!btn && /stroke="currentColor"/.test(String(btn.innerHTML)) && !/fill="(?!none)/.test(String(btn.innerHTML)),
      btn ? String(btn.innerHTML) : 'missing');
    check('the copy button keeps a 44px hit area without painting it',
      !!btn && btn.classList.contains('tap-target'));
  }

  {
    const refs = makeRefs();
    const state = { chat: { modelId: 'gpt-x' }, messages: [] };
    mod.appendMessageToTranscript({ role: 'assistant', content: 'answer', reasoning: '', ts: new Date().toISOString(), modelId: 'gpt-x' }, false, refs, state);
    check('an assistant row mounts a copy button',
      !!refs.transcript.current.children[0].querySelector('.chat-msg__copy'));
  }

  {
    // A live row streams into `_content` (the placeholder message it was
    // built from stays empty), so the button must copy what is on screen when
    // it is tapped, not an empty snapshot. Click the real button and inspect
    // what reached the clipboard.
    const refs = makeRefs();
    const state = { chat: { modelId: 'gpt-x' }, messages: [] };
    mod.__clipboard = '';
    mod.appendMessageToTranscript({ role: 'assistant', content: '', reasoning: '', ts: new Date().toISOString(), modelId: 'gpt-x' }, true, refs, state);
    const row = refs.transcript.current.children[0];
    const btn = row.querySelector('.chat-msg__copy');
    check('a live assistant row mounts a copy button too', !!btn);
    check('the live row is marked as the streaming target', row.dataset.live === '1');
    // Simulate the streamed delta the transcript records on the row.
    row._content = 'streamed answer';
    row._reasoning = 'quietly thought';
    const click = (btn._listeners.click || [])[0];
    check('the copy button has a click handler', typeof click === 'function');
    await click();
    check('the live row copies its streamed content, not the empty placeholder',
    mod.copyState.text === 'streamed answer', JSON.stringify(mod.copyState.text));
    check('the button reports success with a check glyph',
      /<svg/.test(String(btn.innerHTML)) && !/<rect/.test(String(btn.innerHTML)) && /<path/.test(String(btn.innerHTML)),
      String(btn.innerHTML));
    check('the button announces the success state',
      btn.getAttribute('aria-label') === 'Copied message' && btn.classList.contains('is-copied'),
      btn.getAttribute('aria-label'));
  }

  {
    // Error cards keep their own Retry action — no copy button is added, so
    // the two action rows cannot collide.
    const refs = makeRefs();
    const state = { chat: { modelId: 'gpt-x' }, messages: [] };
    mod.appendErrorCard('boom', refs, state, { onRetry() {} });
    const row = refs.transcript.current.children[0];
    check('an error card does not mount a copy button',
      !row.querySelector('.chat-msg__copy'));
    check('an error card still mounts its Retry action',
      !!row.querySelector('.chat-msg__retry'));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
