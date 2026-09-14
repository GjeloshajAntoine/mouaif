'use strict';

// Regression test: opening a chat must show a loading placeholder while the
// load batch is still in flight.
//
// The chat load effect (`useChatState.js`) awaits one `Promise.all` — the chat
// record, the message window, the prompt/tool/agent catalogues — before it can
// render a single row, and the transcript it renders into is mounted empty. On
// a slow link or the first open after a cold start the conversation area was
// therefore blank with no sign anything was happening.
//
// The loader fills that gap: `showTranscriptLoading(refs)` mounts one ring plus
// a sentence, and the rebuild that replaces it clears the placeholder like any
// other non-overlay row. The failure paths swap it for a plain sentence
// (`showTranscriptLoadError`) so a request that never answered leaves a visible
// reason rather than an empty box next to a status line nobody reads.
//
// This is the transcript half of the fix; it asserts on the resulting element
// order and attributes. Remove the helpers and every case fails.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- DOM stub --------------------------------------------------------

function matchesSelector(node, selector) {
  const sel = String(selector).trim();
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  return node.tagName === sel.toUpperCase();
}

function createElement(tag) {
  const classes = new Set();
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    _text: '',
    attributes: {},
    dataset: {},
    style: {},
    classList: {
      add(...names) { for (const n of names) classes.add(n); },
      remove(...names) { for (const n of names) classes.delete(n); },
      contains(name) { return classes.has(name); },
      toggle(name) {
        if (classes.has(name)) { classes.delete(name); return false; }
        classes.add(name);
        return true;
      }
    },
    get className() { return Array.from(classes).join(' '); },
    set className(value) {
      classes.clear();
      for (const part of String(value || '').split(/\s+/)) if (part) classes.add(part);
    },
    get textContent() { return node._text; },
    set textContent(value) { node._text = value == null ? '' : String(value); },
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
    querySelector(selector) { return querySelector(node, selector)[0] || null; },
    querySelectorAll(selector) { return querySelector(node, selector); },
    addEventListener() {},
    removeEventListener() {}
  };
  return node;
}

function querySelector(root, selector) {
  const target = String(selector).trim();
  const direct = target.startsWith(':scope > ');
  const inner = direct ? target.slice(':scope > '.length) : target;
  const out = [];
  const visit = (node, depth) => {
    for (const child of node.children) {
      if (matchesSelector(child, inner) && (!direct || depth === 0)) out.push(child);
      if (!direct || depth === 0) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

// ---- Module loader ---------------------------------------------------

function loadTranscript() {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/transcript.js'), 'utf8');
  const body = source
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
  const base = {
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    document: {
      createElement,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    requestAnimationFrame: (fn) => { setTimeout(fn, 0); return 1; },
    cancelAnimationFrame() {}
  };
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(
    body + '; this.showTranscriptLoading = showTranscriptLoading;'
      + ' this.clearTranscriptLoading = clearTranscriptLoading;'
      + ' this.showTranscriptLoadError = showTranscriptLoadError;'
      + ' this.clearTranscriptRows = clearTranscriptRows;',
    context,
    { filename: 'transcript.js' }
  );
  return context;
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

function main() {
  const mod = loadTranscript();

  // ---- 1. The placeholder mounts with a ring and a sentence ----------
  {
    const el = createElement('div');
    const refs = { transcript: { current: el } };
    mod.showTranscriptLoading(refs);
    check('exactly one placeholder is mounted', el.children.length === 1, String(el.children.length));
    const box = el.children[0];
    check('the placeholder carries its own class', box.classList.contains('chat-view__loading'));
    check('the placeholder is announced as busy',
      box.getAttribute('role') === 'status' && box.getAttribute('aria-busy') === 'true',
      box.getAttribute('role') + '/' + box.getAttribute('aria-busy'));
    check('the ring is decorative',
      !!box.querySelector('.chat-view__loading-spinner')
      && box.querySelector('.chat-view__loading-spinner').getAttribute('aria-hidden') === 'true');
    check('the sentence names the state',
      box.querySelector('.chat-view__loading-text').textContent === 'Loading conversation…',
      box.querySelector('.chat-view__loading-text').textContent);
  }

  // ---- 2. Mounting twice does not stack placeholders ----------------
  {
    const el = createElement('div');
    const refs = { transcript: { current: el } };
    mod.showTranscriptLoading(refs);
    mod.showTranscriptLoading(refs);
    check('a second start replaces the first placeholder',
      el.children.filter((c) => c.classList.contains('chat-view__loading')).length === 1,
      String(el.children.length));
  }

  // ---- 3. The rebuild clears it -------------------------------------
  {
    const el = createElement('div');
    const refs = { transcript: { current: el } };
    mod.showTranscriptLoading(refs);
    mod.clearTranscriptRows(el);
    check('clearTranscriptRows drops the placeholder', el.children.length === 0, String(el.children.length));
    check('clearTranscriptLoading is a no-op on an empty transcript', (() => {
      mod.clearTranscriptLoading(refs);
      return el.children.length === 0;
    })());
    const row = createElement('div');
    row.className = 'chat-msg chat-msg--user';
    el.appendChild(row);
    mod.showTranscriptLoading(refs);
    check('the placeholder replaces pre-existing rows', el.children.length === 1
      && el.children[0].classList.contains('chat-view__loading'));
  }

  // ---- 4. The failure sentence replaces the ring --------------------
  {
    const el = createElement('div');
    const refs = { transcript: { current: el } };
    mod.showTranscriptLoading(refs);
    mod.showTranscriptLoadError(refs, 'Could not load this chat.');
    check('the error state is a single row', el.children.length === 1, String(el.children.length));
    const box = el.children[0];
    check('the error row keeps the shared class and adds the error flag',
      box.classList.contains('chat-view__loading') && box.classList.contains('chat-view__loading--error'));
    check('the error row drops the ring', box.querySelector('.chat-view__loading-spinner') === null);
    check('the error row shows the reason',
      box.querySelector('.chat-view__loading-text').textContent === 'Could not load this chat.',
      box.querySelector('.chat-view__loading-text').textContent);
    check('the error row is not announced as busy', box.getAttribute('aria-busy') === null);
    mod.clearTranscriptLoading(refs);
    check('clearTranscriptLoading also clears an error row', el.children.length === 0, String(el.children.length));
  }

  // ---- 5. A loader with no transcript is inert ----------------------
  {
    mod.showTranscriptLoading({ transcript: { current: null } });
    mod.clearTranscriptLoading({ transcript: { current: null } });
    mod.showTranscriptLoadError({ transcript: { current: null } }, 'x');
    mod.showTranscriptLoading({});
    check('a missing transcript node never throws', true);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
