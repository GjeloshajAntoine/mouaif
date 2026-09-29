'use strict';

// Regression test: an expanded tool card must show the same thing for every
// tool type, and must not depend on which side of the call/result pair the
// render reached first.
//
// Three defects this pins, all of which made an expanded card render less
// than the transcript already held:
//
//   1. The collapsed head lost its one-line arguments on the result-first
//      path. `appendToolResultCard` only formatted `headArgs` for subagent /
//      shell / a `cmd` field, so a card built from its result row (the
//      tail-first chunked render, a pagination page, a reconcile that had
//      dropped the stashed `card._toolArgs`) read `Read | ok` — no path, no
//      query — while the same call built from its call row read
//      `Read | src/a.js lines 1-50 | ok`.
//
//   2. Only the shell renderer rendered the call's arguments. `buildToolArgs`
//      already labelled a non-shell block "Arguments" and was written to be
//      general, but nothing but `renderShellToolResult` called it, so an MCP
//      card showed the result and never what was asked. `search_files` also
//      never showed the SCOPE it ran against, because the scope is an
//      argument and the result carries only the query.
//
//   3. `list_files` / `search_files` rows clipped with `text-overflow:
//      ellipsis` instead of wrapping, so a deep path or a long matched line
//      was cut at the card edge — the expanded card is the only place a
//      result is readable, so a clipped row meant the content was nowhere.
//
// Loaded the way the sibling transcript tests load it: the import blocks are
// stripped and the bodies run in one VM context whose globals auto-provide the
// remaining helpers.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHAT_DIR = path.join(__dirname, '../frontend/src/components/chat');
const CSS_PATH = path.join(__dirname, '../frontend/src/tool-cards.css');

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

function matchesSelector(node, selector) {
  const sel = String(selector).trim();
  if (sel.startsWith(':scope > ')) return false; // direct-children only; handled below
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
    cssEscape: (value) => String(value),
    publishWebPreview() {},
    cancelToolBodyScroll() {},
    scrollToolBodyToBottomSoon() {},
    afterTranscriptAppend() {},
    pinTranscriptAfterSettle() {}
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
    transcript + '; this.appendToolCallCard = appendToolCallCard; this.appendToolResultCard = appendToolResultCard;',
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

// ---- Assertions ------------------------------------------------------

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// One case per renderer family. `expectArgs` is a fragment that must appear in
// the expanded body for the card to be showing what the model actually asked.
const CASES = [
  {
    name: 'shell', id: 'call_shell',
    args: { cmd: 'cd /x && ls -la' },
    result: { stdout: 'a\nb', stderr: '', exitCode: 0, identity: 'bash', durationMs: 3 },
    headFragment: 'cd /x && ls -la',
    bodyFragment: 'cd /x && ls -la'
  },
  {
    name: 'read_file', id: 'call_read',
    args: { path: 'src/a.js', startLine: 1, endLine: 50 },
    result: { relPath: 'src/a.js', body: 'x=1', startLine: 1, endLine: 50, totalLines: 200 },
    headFragment: 'src/a.js lines 1-50',
    bodyFragment: 'x=1'
  },
  {
    name: 'search_files', id: 'call_search',
    args: { path: 'src/lib', query: 'foo' },
    result: { query: 'foo', matches: [{ path: 'src/lib/a.js', line: 3, text: 'foo' }] },
    headFragment: 'src/lib: foo',
    // The scope is an argument, not part of the result; the card must show it.
    bodyFragment: 'in src/lib'
  },
  {
    name: 'webpreview', id: 'call_web',
    args: { url: 'https://example.com/page' },
    result: { mode: 'live', url: 'https://example.com/page' },
    headFragment: 'https://example.com/page',
    // Which page was captured is an argument, not part of the result body.
    bodyFragment: 'https://example.com/page'
  },
  {
    name: 'mcp__x__search', id: 'call_mcp',
    args: { query: 'weather', limit: 5 },
    result: { content: [{ type: 'text', text: 'result text' }] },
    headFragment: '"query": "weather"',
    // The MCP card showed only the response; it must also show the request.
    bodyFragment: '"query": "weather"'
  },
  {
    name: 'git_diff_unstaged', id: 'call_git',
    args: { repo_path: '/proj' },
    result: { content: [{ type: 'text', text: 'diff --git a' }] },
    headFragment: 'repo_path',
    bodyFragment: 'repo_path'
  }
];

function main() {
  const mod = installContext();

  // ---- 1. Every type renders the same card either render order ------
  //
  // The live path builds the card from its call row; the tail-first chunked
  // render / a pagination page / a reconcile can reach the result row first.
  // Both must end with the same head AND the same body.
  for (const c of CASES) {
    const callFirst = makeRefs();
    mod.appendToolCallCard({ id: c.id, name: c.name, args: c.args }, callFirst);
    mod.appendToolResultCard({ id: c.id, name: c.name, ok: true, result: c.result }, callFirst);
    let card = callFirst.transcript.current.children[0];
    if (card && typeof card._lazyBody === 'function') card._lazyBody();

    const resultFirst = makeRefs();
    mod.appendToolResultCard({ id: c.id, name: c.name, ok: true, result: c.result, args: c.args }, resultFirst);
    let card2 = resultFirst.transcript.current.children[0];
    if (card2 && typeof card2._lazyBody === 'function') card2._lazyBody();

    const headA = card ? textOf(card.querySelector('.tool-card__head')) : '(no card)';
    const headB = card2 ? textOf(card2.querySelector('.tool-card__head')) : '(no card)';
    const bodyA = card ? textOf(card.querySelector('.tool-card__body')) : '(no card)';
    const bodyB = card2 ? textOf(card2.querySelector('.tool-card__body')) : '(no card)';

    check(c.name + ': the head reads the same from either row',
      headA === headB, JSON.stringify(headA) + ' vs ' + JSON.stringify(headB));
    check(c.name + ': the body reads the same from either row',
      bodyA === bodyB, JSON.stringify(bodyA) + ' vs ' + JSON.stringify(bodyB));
  }

  // ---- 2. The result-first head still carries its arguments ---------
  //
  // The specific regression: a card built from ONLY the result row used to
  // lose the head's one-line arguments for every type except shell/subagent.
  for (const c of CASES) {
    const refs = makeRefs();
    // No `args` on the result event — the worst case, where the only truth is
    // the persisted call row (exercised through `card._toolArgs` here).
    mod.appendToolResultCard({ id: c.id, name: c.name, ok: true, result: c.result, args: c.args }, refs);
    const card = refs.transcript.current.children[0];
    const head = card ? textOf(card.querySelector('.tool-card__head')) : '';
    check(c.name + ': the collapsed head shows the call arguments',
      head.includes(c.headFragment),
      'head=' + JSON.stringify(head.replace(/\n+/g, ' | ')) + ' wanted=' + JSON.stringify(c.headFragment));
  }

  // ---- 3. The expanded body shows what the model asked for ----------
  for (const c of CASES) {
    const refs = makeRefs();
    mod.appendToolResultCard({ id: c.id, name: c.name, ok: true, result: c.result, args: c.args }, refs);
    const card = refs.transcript.current.children[0];
    if (card && typeof card._lazyBody === 'function') card._lazyBody();
    const body = card ? textOf(card.querySelector('.tool-card__body')) : '';
    check(c.name + ': the expanded body shows the call',
      body.includes(c.bodyFragment),
      'body=' + JSON.stringify(body.replace(/\n+/g, ' | ')) + ' wanted=' + JSON.stringify(c.bodyFragment));
  }

  // ---- 4. A call with no arguments adds no empty block --------------
  {
    const refs = makeRefs();
    mod.appendToolResultCard({ id: 'call_none', name: 'mcp__x__ping', ok: true, result: { content: [{ type: 'text', text: 'pong' }] }, args: {} }, refs);
    const card = refs.transcript.current.children[0];
    if (card && typeof card._lazyBody === 'function') card._lazyBody();
    const body = card ? textOf(card.querySelector('.tool-card__body')) : '';
    check('an empty argument object renders no Arguments block',
      !body.includes('Arguments'), JSON.stringify(body));
  }

  // ---- 5. Listed paths and matches wrap instead of clipping ---------
  //
  // The expanded card is the only place a result is readable, so a clipped
  // row there means the content was nowhere at all.
  {
    const css = fs.readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const cls of ['tool-preview__file', 'tool-preview__match', 'tool-preview__match-text']) {
      const rule = new RegExp('(?:^|})\\s*\\.' + cls.replace(/[.-]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm').exec(css);
      check('.' + cls + ' has a rule', !!rule);
      if (!rule) continue;
      check('.' + cls + ' does not clip with nowrap/ellipsis',
        !/white-space:\s*nowrap/.test(rule[1]) && !/text-overflow:\s*ellipsis/.test(rule[1]),
        rule[1].trim());
      check('.' + cls + ' wraps long content',
        /overflow-wrap:\s*anywhere/.test(rule[1]), rule[1].trim());
    }
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
