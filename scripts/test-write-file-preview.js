'use strict';

// Regression test: expanding a `write_file` tool card must show the
// content the model wrote.
//
// The `tool_result` SSE frame carries metadata only (path, chars, lines),
// so the content lives in the call's arguments. A card can be built from
// either side of the call/result pair:
//
//   * live stream — the `tool_call` card exists first and stashes its
//     args, the result updates it (args come from the card);
//   * replay — the tail-first chunked render paints the newest rows
//     first, so a result row whose call row is still in the backfill
//     builds the card and wins the tool-id de-dup; renderMessageRow then
//     has to recover the args from the persisted call row.
//
// Both paths must end with the written content in the expanded body, and
// a huge write must not be painted in full.
//
// Loaded the way the other transcript tests load the module: the import
// blocks are stripped and the bodies run in one VM context whose globals
// auto-provide the remaining helpers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHAT_DIR = path.join(__dirname, '../frontend/src/components/chat');

// ---- DOM stub --------------------------------------------------------

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
      while (cur) {
        if (matchesSelector(cur, selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    querySelector(selector) { return querySelector(node, selector)[0] || null; },
    querySelectorAll(selector) { return querySelector(node, selector); },
    addEventListener() {},
    removeEventListener() {}
  };
  return node;
}

// Supports the selectors the transcript code actually uses: `.class`,
// `[data-x="value"]`, and `:scope > .class` (direct children only).
function matchesSelector(node, selector) {
  const sel = String(selector).trim();
  if (sel.startsWith(':scope > ')) return false; // handled by the caller
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

function textOf(node) {
  const parts = [];
  if (node._text) parts.push(node._text);
  for (const child of node.children) parts.push(textOf(child));
  return parts.join('\n');
}

function findPre(body, className) {
  return querySelector(body, '.tool-preview__pre').find((el) => el.classList.contains(className)) || null;
}

// ---- Module loader ---------------------------------------------------

function installContext() {
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
    // Real implementations the render path depends on. The Proxy below
    // auto-stubs anything else the modules import.
    cssEscape: (value) => String(value),
    publishWebPreview() {}
  };
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  // tools.js and toolRender.js first: transcript.js resolves their
  // exports (renderToolResultBody, coerceToolResult, ...) as globals.
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
    transcript + '; this.appendToolCallCard = appendToolCallCard; this.appendToolResultCard = appendToolResultCard;'
      + ' this.renderMessageRow = renderMessageRow; this.toolCallArgsFor = toolCallArgsFor;',
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
    _suspendScrollPin: false
  };
}

// ---- Assertions ------------------------------------------------------

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

const WRITTEN = 'export function greet() {\n  return "hi";\n}\n';
const WRITE_ARGS = { path: 'src/greet.js', content: WRITTEN };
const WRITE_RESULT = { relPath: 'src/greet.js', chars: WRITTEN.length, lines: 3 };
const CALL_ID = 'call_write_1';

function main() {
  const mod = installContext();

  // ---- 1. Live order: call card, then its result ----------------
  {
    const refs = makeRefs();
    mod.appendToolCallCard({ id: CALL_ID, name: 'write_file', args: WRITE_ARGS }, refs);
    mod.appendToolResultCard({ id: CALL_ID, name: 'write_file', ok: true, result: WRITE_RESULT }, refs);
    const card = refs.transcript.current.children[0];
    check('the call card is reused by the result', refs.transcript.current.children.length === 1,
      String(refs.transcript.current.children.length));
    const body = card.querySelector('.tool-card__body');
    check('an unexpanded card paints no content', body.children.length === 0, String(body.children.length));
    card._lazyBody();
    const pre = findPre(body, 'tool-preview__pre--content');
    check('expanding shows the written content', !!pre && pre.textContent === WRITTEN,
      pre ? JSON.stringify(pre.textContent) : 'no content pre');
    const meta = body.querySelector('.tool-preview__meta');
    check('the meta line still carries the path and size',
      !!meta && meta.textContent.includes('src/greet.js') && meta.textContent.includes('chars'),
      meta && meta.textContent);
  }

  // ---- 2. Replay order: result row before its call row ----------
  {
    const refs = makeRefs();
    const state = {
      messages: [
        { role: 'user', content: 'write it' },
        { role: 'tool', phase: 'call', toolCallId: CALL_ID, name: 'write_file', args: WRITE_ARGS },
        { role: 'tool', phase: 'result', toolCallId: CALL_ID, name: 'write_file', ok: true, content: JSON.stringify(WRITE_RESULT) }
      ]
    };
    // The tail phase reaches the result row first (its call row sits in
    // the backfill), so the card is built from the result alone.
    mod.renderMessageRow(state, refs, state.messages[2]);
    const card = refs.transcript.current.children[0];
    check('the result row builds a card on its own', !!card && card.dataset.toolName === 'write_file');
    check('its arguments are recovered from the persisted call row',
      card._toolArgs && card._toolArgs.content === WRITTEN);
    card._lazyBody();
    const pre = findPre(card.querySelector('.tool-card__body'), 'tool-preview__pre--content');
    check('the recovered args render the content too', !!pre && pre.textContent === WRITTEN,
      pre ? JSON.stringify(pre.textContent) : 'no content pre');
    // The call row is then skipped by the de-dup guard and must not add
    // a second, content-less card.
    mod.renderMessageRow(state, refs, state.messages[1]);
    check('the late call row does not duplicate the card', refs.transcript.current.children.length === 1,
      String(refs.transcript.current.children.length));
  }

  // ---- 3. A huge write is truncated, not painted whole ----------
  {
    const refs = makeRefs();
    const big = Array.from({ length: 3000 }, (_, i) => 'line ' + i).join('\n');
    mod.appendToolCallCard({ id: 'call_big', name: 'write_file', args: { path: 'big.txt', content: big } }, refs);
    mod.appendToolResultCard({ id: 'call_big', name: 'write_file', ok: true, result: { relPath: 'big.txt', chars: big.length } }, refs);
    const card = refs.transcript.current.children[0];
    card._lazyBody();
    const pre = findPre(card.querySelector('.tool-card__body'), 'tool-preview__pre--content');
    check('a huge write is capped', !!pre && pre.textContent.length < big.length
      && pre.textContent.includes('preview truncated'),
      pre ? String(pre.textContent.length) : 'no content pre');
    check('the cap keeps the head of the content',
      !!pre && pre.textContent.startsWith('line 0\nline 1\n'));
  }

  // ---- 4. No args available still renders the plain card --------
  {
    const refs = makeRefs();
    mod.appendToolResultCard({ id: 'call_orphan', name: 'write_file', ok: true, result: WRITE_RESULT }, refs);
    const card = refs.transcript.current.children[0];
    card._lazyBody();
    const body = card.querySelector('.tool-card__body');
    check('an orphan result keeps the "write complete" line',
      textOf(body).includes('write complete'), textOf(body));
  }

  // ---- 5. edit_file keeps its diff preview ----------------------
  {
    const refs = makeRefs();
    mod.appendToolCallCard({ id: 'call_edit', name: 'edit_file', args: { path: 'a.js', oldText: 'x', newText: 'y' } }, refs);
    mod.appendToolResultCard({
      id: 'call_edit', name: 'edit_file', ok: true,
      result: { relPath: 'a.js', addedChars: 1, removedChars: 1, diff: '-x\n+y' }
    }, refs);
    const card = refs.transcript.current.children[0];
    card._lazyBody();
    const diff = card.querySelector('.tool-preview__diff');
    check('edit_file still renders a diff preview', !!diff,
      textOf(card.querySelector('.tool-card__body')));
    check('edit_file does not render file content',
      !findPre(card.querySelector('.tool-card__body'), 'tool-preview__pre--content'));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
