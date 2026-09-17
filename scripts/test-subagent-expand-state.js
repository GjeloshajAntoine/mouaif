'use strict';

// Regression test: a subagent tool card must actually collapse.
//
// A subagent card's body IS its delegated transcript, and the renderer
// leaves a settled card open (`is-expanded`) so the transcript is readable
// without a tap. The header's collapse toggle was a no-op for these cards
// because two CSS rules in frontend/src/tool-cards.css forced the body
// visible regardless of `is-expanded`:
//
//   1. the hide rule explicitly excluded subagent cards —
//      `:not(...):not(.tool-card--subagent) … { display: none }`; and
//   2. a blanket `.tool-card--subagent .tool-card__body { display: block; }`
//      at higher specificity.
//
// So a card the user collapsed (or one rebuilt from `_userCollapsed`
// intent) still painted its whole nested conversation — it looked
// permanently expanded. `is-expanded` is authoritative again: the hide
// rule covers subagent cards, and the panel rule on the body keeps only
// the surface (background/border/type), never `display`.
//
// A DOM stub cannot evaluate CSS, so — like scripts/test-shell-card-command.js
// — the cascade is checked by resolving the actual `.tool-card__body` rules
// from the stylesheet against a modelled subagent card, in both states.
// The renderer's own collapse-intent behavior is then exercised through the
// VM-loaded module.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CSS_PATH = path.join(__dirname, '../frontend/src/tool-cards.css');

// ---- Minimal CSS cascade resolver ------------------------------------
//
// Covers exactly the selector constructs the `.tool-card__body` rules use:
// descendant compounds made of `.class`, `:not(<compound>)`,
// `:where(<compound>)` and `:empty`. Enough to answer "which `display`
// wins for a subagent card body, collapsed vs expanded?" — which is the
// question the defect turned on.

function splitRules(css) {
  const out = [];
  // Strip comments first: the naive block regex below would otherwise
  // swallow a comment into the following rule's selector text.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const selector = m[1].trim();
    const body = m[2];
    out.push({ selector, body });
  }
  return out;
}

// Parse one compound (no whitespace) into tokens.
function parseCompound(text) {
  const tokens = [];
  let i = 0;
  const readInner = (openIdx) => {
    // text[openIdx] === '(' — read to the matching close, allowing nesting.
    let depth = 0;
    for (let j = openIdx; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') {
        depth--;
        if (depth === 0) return { inner: text.slice(openIdx + 1, j), end: j + 1 };
      }
    }
    return { inner: text.slice(openIdx + 1), end: text.length };
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '.') {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_-]/.test(text[j])) j++;
      tokens.push({ kind: 'class', name: text.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === ':') {
      const nameMatch = /^:([a-z-]+)/i.exec(text.slice(i));
      const name = nameMatch ? nameMatch[1] : '';
      const after = i + nameMatch[0].length;
      if ((name === 'not' || name === 'where') && text[after] === '(') {
        const { inner, end } = readInner(after);
        tokens.push({ kind: name, inner });
        i = end;
        continue;
      }
      if (name === 'empty') {
        tokens.push({ kind: 'empty' });
        i = after;
        continue;
      }
      // Any other pseudo-class is not part of the rules under test.
      tokens.push({ kind: 'pseudo', name });
      i = after;
      continue;
    }
    // A bare tag/type selector.
    let j = i;
    while (j < text.length && /[A-Za-z0-9_-]/.test(text[j])) j++;
    if (j === i) { i++; continue; }
    tokens.push({ kind: 'tag', name: text.slice(i, j).toUpperCase() });
    i = j;
  }
  return tokens;
}

// Parse a full selector into whitespace-separated compounds.
function parseSelector(selector) {
  // Drop the `:scope > ` prefix the sibling stubs mention; these rules are
  // all descendant selectors.
  return selector.split(/\s+/).filter(Boolean).map(parseCompound);
}

// Split on a separator only at paren depth 0. A naive `split(',')` would
// cut inside `:where(:not(a):not(b))` and produce fragments that parse as
// nonsense (`:tool-card--authorization)`), which is exactly the selector
// shape the hide rule uses.
function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function compoundMatches(node, tokens) {
  for (const t of tokens) {
    if (t.kind === 'class' && !node.classes.has(t.name)) return false;
    if (t.kind === 'tag' && node.tagName !== t.name) return false;
    if (t.kind === 'empty' && node.childElementCount !== 0) return false;
    if (t.kind === 'pseudo' && t.name !== 'empty') return false;
    if (t.kind === 'not') {
      // :not() holds one or more compounds; none may match.
      const inner = splitTopLevel(t.inner, ',').map((s) => s.trim()).filter(Boolean);
      if (inner.some((sel) => compoundMatches(node, parseCompound(sel)))) return false;
    }
    if (t.kind === 'where') {
      const inner = splitTopLevel(t.inner, ',').map((s) => s.trim()).filter(Boolean);
      if (!inner.some((sel) => compoundMatches(node, parseCompound(sel)))) return false;
    }
  }
  return true;
}

// Descendant matching: the last compound must match `node`, and the
// remaining compounds must match its ancestors in order.
function selectorMatches(node, compounds) {
  const last = compounds[compounds.length - 1];
  if (!compoundMatches(node, last)) return false;
  let cursor = node.parentNode;
  for (let k = compounds.length - 2; k >= 0; k--) {
    let found = false;
    while (cursor) {
      if (compoundMatches(cursor, compounds[k])) { found = true; cursor = cursor.parentNode; break; }
      cursor = cursor.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

// Specificity as a single comparable number. `:where()` contributes zero;
// `:not()` contributes the specificity of its most specific argument;
// class and pseudo-class each contribute one "a" unit.
function countSpecificity(tokens) {
  let s = 0;
  for (const t of tokens) {
    if (t.kind === 'class' || t.kind === 'empty') s += 1;
    if (t.kind === 'pseudo') s += 1;
    if (t.kind === 'not') {
      const inner = splitTopLevel(t.inner, ',').map((x) => x.trim()).filter(Boolean);
      s += Math.max(0, ...inner.map((sel) => countSpecificity(parseCompound(sel))));
    }
    // `where` adds nothing.
  }
  return s;
}

function selectorSpecificity(compounds) {
  return compounds.reduce((sum, c) => sum + countSpecificity(c), 0);
}

// ---- Node model ------------------------------------------------------

function modelNode(tagName, classes, childElementCount) {
  return { tagName: String(tagName).toUpperCase(), classes: new Set(classes), childElementCount: childElementCount || 0, parentNode: null };
}

// The card body inside a subagent card. `collapsed` decides whether the
// card carries `is-expanded`; the body always has the nested chat as a
// child (so `:empty` never matches the case under test).
function subagentBody(collapsed) {
  const body = modelNode('div', ['tool-card__body'], 1);
  const cardClasses = ['tool-card', 'tool-card--call', 'tool-card--result', 'tool-card--subagent'];
  if (!collapsed) cardClasses.push('is-expanded');
  const card = modelNode('div', cardClasses, 2);
  body.parentNode = card;
  return body;
}

// Resolve the winning `display` for `node` from the stylesheet's
// `.tool-card__body` display declarations. Returns the value or '(unset)'.
function resolveDisplay(css, node) {
  let winner = null;
  for (const rule of splitRules(css)) {
    if (!/\.tool-card__body/.test(rule.selector)) continue;
    const displayMatch = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(rule.body);
    if (!displayMatch) continue;
    const value = displayMatch[1].trim();
    // A selector list: any selector that matches may apply.
    for (const one of splitTopLevel(rule.selector, ',')) {
      const compounds = parseSelector(one.trim());
      if (!compounds.length) continue;
      if (!selectorMatches(node, compounds)) continue;
      const spec = selectorSpecificity(compounds);
      if (!winner || spec >= winner.spec) winner = { spec, value, selector: one.trim() };
    }
  }
  return winner ? winner.value : '(unset)';
}

// ---- DOM stub + module loader (shared shape with the sibling tests) ---

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
    formatToolArgs: (args) => (args && typeof args === 'object' ? (args.task || JSON.stringify(args)) : String(args == null ? '' : args)),
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

function main() {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  // Source-shape checks run against the comment-stripped stylesheet, so a
  // selector quoted inside an explanatory comment cannot masquerade as a
  // live rule (the removed blanket rule is literally cited in the comment
  // that explains why it is gone).
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // ---- 1. The cascade: `is-expanded` owns subagent visibility ---------
  {
    const collapsed = resolveDisplay(css, subagentBody(true));
    const expanded = resolveDisplay(css, subagentBody(false));
    check('a COLLAPSED subagent card hides its body', collapsed === 'none', collapsed);
    check('an EXPANDED subagent card shows its body', expanded === 'block', expanded);
  }

  // ---- 2. The specific rules that welded the body open are gone -------
  {
    // The old hide rule opted subagent cards out entirely.
    const hideRule = /\.tool-card:where\([^)]*\)[^{]*\.tool-card__body\s*\{[^}]*display:\s*none[^}]*\}/m.exec(cssCode);
    check('the collapsed-body hide rule is present', !!hideRule, String(hideRule));
    if (hideRule) {
      check('the hide rule no longer exempts subagent cards',
        !/:not\(\.tool-card--subagent\)/.test(hideRule[0]),
        hideRule[0]);
    }

    // The old blanket rule forced the body visible at (0,2,0), and the
    // panel rule forced it again at (0,3,0).
    const blanket = /\.tool-card--subagent\s+\.tool-card__body\s*\{[^}]*display:\s*block[^}]*\}/m.exec(cssCode);
    check('the blanket visible-body rule is removed', !blanket, blanket && blanket[0]);

    const panel = /\.tool-card\.tool-card--subagent\s+\.tool-card__body\s*\{([^}]*)\}/m.exec(cssCode);
    check('the subagent panel rule exists', !!panel, String(panel));
    if (panel) {
      check('the panel rule keeps the surface (background/border)',
        /background:\s*var\(--surface\)/.test(panel[1]) && /border:\s*1px solid var\(--border\)/.test(panel[1]),
        panel[1]);
      check('the panel rule does NOT declare display', !/display\s*:/.test(panel[1]), panel[1]);
    }
  }

  // ---- 3. Neighbouring card families keep their own behavior ----------
  {
    // Progress cards keep an always-visible body.
    const progressBody = (() => {
      const body = modelNode('div', ['tool-card__body'], 1);
      body.parentNode = modelNode('div', ['tool-card', 'tool-card--call', 'tool-card--result', 'tool-card--progress'], 2);
      return body;
    })();
    check('a collapsed progress card still shows its body',
      resolveDisplay(css, progressBody) === 'block', resolveDisplay(css, progressBody));

    // A plain (non-subagent) result card still hides when collapsed.
    const plain = (() => {
      const body = modelNode('div', ['tool-card__body'], 1);
      body.parentNode = modelNode('div', ['tool-card', 'tool-card--call', 'tool-card--result'], 2);
      return body;
    })();
    check('a collapsed ordinary result card hides its body',
      resolveDisplay(css, plain) === 'none', resolveDisplay(css, plain));
  }

  // ---- 4. The renderer leaves a settled card open, but honors intent --
  {
    const mod = loadTranscript(installDom());

    // A fresh settled subagent result opens itself.
    {
      const refs = makeRefs();
      mod.appendToolResultCard({
        id: 'c1', name: 'subagent', ok: true,
        args: { task: 'Go' },
        result: { ok: true, text: 'done', chat: [{ role: 'assistant', content: 'done' }] }
      }, refs);
      const card = refs.transcript.current.children[0];
      check('a settled subagent card is left expanded', !!card && card.classList.contains('is-expanded'),
        card && card.className);
    }

    // A user collapse must survive the result landing on the same card.
    {
      const refs = makeRefs();
      mod.appendToolCallCard({ id: 'c2', name: 'subagent', args: { task: 'Go' } }, refs);
      const card = refs.transcript.current.children[0];
      // Simulate the header tap: the user collapses and that intent is
      // recorded on the card (buildToolCardHead's handler).
      card.classList.remove('is-expanded');
      card._userCollapsed = true;
      mod.appendToolResultCard({
        id: 'c2', name: 'subagent', ok: true,
        args: { task: 'Go' },
        result: { ok: true, text: 'done', chat: [{ role: 'assistant', content: 'done' }] }
      }, refs);
      check('a card the user collapsed stays collapsed when its result lands',
        refs.transcript.current.children.length === 1
        && !refs.transcript.current.children[0].classList.contains('is-expanded'),
        refs.transcript.current.children[0].className);
    }
  }

  // ---- 5. A rebuild preserves the user's collapse --------------------
  {
    const mod = loadTranscript(installDom());

    // Source transcript: one collapsed-by-the-user subagent card.
    const source = createElement('div');
    source.className = 'chat-view__transcript';
    const old = createElement('div');
    old.className = 'tool-card tool-card--call tool-card--result tool-card--subagent';
    old.dataset.toolId = 'c1';
    old._userCollapsed = true;
    source.appendChild(old);

    const snapped = mod.snapshotExpandedState(source);
    check('a user-collapsed subagent card is remembered as collapsed',
      snapped.collapsedToolIds.has('c1') && !snapped.toolIds.has('c1'),
      JSON.stringify({ collapsed: Array.from(snapped.collapsedToolIds), open: Array.from(snapped.toolIds) }));

    // Fresh rebuild: the renderer expanded it again.
    const target = createElement('div');
    target.className = 'chat-view__transcript';
    const fresh = createElement('div');
    fresh.className = 'tool-card tool-card--call tool-card--result tool-card--subagent is-expanded';
    fresh.dataset.toolId = 'c1';
    target.appendChild(fresh);

    mod.restoreExpandedState(snapped, target);
    check('a rebuilt card keeps the user\'s collapse',
      !fresh.classList.contains('is-expanded') && fresh._userCollapsed === true,
      fresh.className + ' _userCollapsed=' + fresh._userCollapsed);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

assert.ok(true);
main();
