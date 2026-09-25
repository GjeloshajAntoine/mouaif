'use strict';

// Regression test: an EXPANDED system-prompt card must WRAP.
//
// The system prompt (top-level, and the nested one inside an expanded
// subagent card) is rendered as a `<pre class="chat-msg__system-body">` by
// buildSystemPromptRow (frontend/src/components/chat/transcript.js). Two
// stylesheets describe a `<pre>` inside an assistant/system bubble:
//
//   chat-transcript.css  `.chat-msg--system .chat-msg__system-body` (0,2,0)
//                        → white-space: pre-wrap   (the prompt wraps)
//   chat-markdown.css    `:is(.chat-msg--assistant, .chat-msg--system)
//                        .chat-msg__body pre` (0,2,1)
//                        → white-space: pre        (a markdown CODE BLOCK)
//
// The markdown rule was written for fenced code blocks, but its selector
// also matched the system prompt's `<pre>`, and at one point of extra
// specificity it won: the prompt rendered as a single unbroken line in a
// horizontally scrolling box. On a 390 px phone the visible part was
// ~330 px of a ~2000 px line — the instructions the model was given were
// there but unreadable without an invisible sideways swipe, in both the
// top-level card and the subagent card.
//
// The fix excludes `.chat-msg__system-body` from the code-block rule so the
// dedicated rule owns the prompt's type, wrapping and geometry. A DOM stub
// cannot evaluate this cascade, so — like scripts/test-subagent-expand-state.js
// — the winning `white-space` is resolved from the real stylesheets against
// modelled nodes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '../frontend/src');
const TRANSCRIPT_CSS = path.join(SRC, 'chat-transcript.css');
const MARKDOWN_CSS = path.join(SRC, 'chat-markdown.css');
const TRANSCRIPT_JS = path.join(SRC, 'components/chat/transcript.js');

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? '  → ' + detail : '')); }
}

// ---- Minimal CSS cascade resolver ------------------------------------
//
// Covers exactly the constructs the two competing rules use: descendant
// compounds of `.class`, a type selector, and the `:is()` / `:not()` /
// `:where()` functional pseudo-classes. Enough to answer "which
// `white-space` wins for the prompt's <pre>?" — which is what the defect
// turned on.

function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function splitRules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(css)))) {
    const selector = m[1].trim();
    if (selector.startsWith('@')) continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

function readInner(text, openIdx) {
  let depth = 0;
  for (let j = openIdx; j < text.length; j++) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')') {
      depth--;
      if (depth === 0) return { inner: text.slice(openIdx + 1, j), end: j + 1 };
    }
  }
  return { inner: text.slice(openIdx + 1), end: text.length };
}

// Parse one compound (no whitespace) into tokens.
function parseCompound(text) {
  const tokens = [];
  let i = 0;
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
      const m = /^:([a-z-]+)/i.exec(text.slice(i));
      const name = m ? m[1].toLowerCase() : '';
      const after = i + (m ? m[0].length : 1);
      if ((name === 'is' || name === 'not' || name === 'where') && text[after] === '(') {
        const { inner, end } = readInner(text, after);
        tokens.push({ kind: name, inner });
        i = end;
        continue;
      }
      // Any other pseudo-class is not part of the rules under test.
      tokens.push({ kind: 'pseudo', name });
      i = after;
      continue;
    }
    let j = i;
    while (j < text.length && /[A-Za-z0-9_-]/.test(text[j])) j++;
    if (j === i) { i++; continue; }
    tokens.push({ kind: 'tag', name: text.slice(i, j).toUpperCase() });
    i = j;
  }
  return tokens;
}

function parseSelector(selector) {
  // Split on whitespace only at paren depth 0. A naive `split(/\s+/)`
  // cuts inside `:is(.a, .b)` — whose author wrote a space after the
  // comma — and produces fragments (`:is(.a,` / `.b)`) that parse as
  // nonsense, exactly the selector shape the markdown rule uses.
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (/\s/.test(ch) && depth === 0) {
      if (i > start) parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  if (start < selector.length) parts.push(selector.slice(start));
  return parts.filter(Boolean).map(parseCompound);
}

function innerSelectors(t) {
  return splitTopLevel(t.inner, ',').map((s) => s.trim()).filter(Boolean);
}

function compoundMatches(node, tokens) {
  for (const t of tokens) {
    if (t.kind === 'class' && !node.classes.has(t.name)) return false;
    if (t.kind === 'tag' && node.tagName !== t.name) return false;
    if (t.kind === 'pseudo') return false; // unsupported → treat as non-matching
    if (t.kind === 'is') {
      if (!innerSelectors(t).some((sel) => {
        const compounds = parseSelector(sel);
        return compounds.length === 1 && compoundMatches(node, compounds[0]);
      })) return false;
    }
    if (t.kind === 'not') {
      if (innerSelectors(t).some((sel) => {
        const compounds = parseSelector(sel);
        return compounds.length === 1 && compoundMatches(node, compounds[0]);
      })) return false;
    }
    if (t.kind === 'where') {
      // `:where()` with a compound inside matches like `:is()`, but adds no
      // specificity (handled in countSpecificity).
      if (!innerSelectors(t).some((sel) => {
        const compounds = parseSelector(sel);
        return compounds.length === 1 && compoundMatches(node, compounds[0]);
      })) return false;
    }
  }
  return true;
}

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

function countSpecificity(tokens) {
  let s = 0;
  for (const t of tokens) {
    if (t.kind === 'class' || t.kind === 'pseudo') s += 1;
    if (t.kind === 'is' || t.kind === 'not') {
      s += Math.max(0, ...innerSelectors(t).map((sel) =>
        parseSelector(sel).reduce((sum, c) => sum + countSpecificity(c), 0)));
    }
    // `where` adds nothing.
  }
  return s;
}

function selectorSpecificity(compounds) {
  return compounds.reduce((sum, c) => sum + countSpecificity(c), 0);
}

// Resolve a property for `node` from an ordered list of stylesheets.
function resolveProperty(sheets, node, prop) {
  let winner = null;
  for (const css of sheets) {
    for (const rule of splitRules(css)) {
      const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)');
      const m = re.exec(rule.body);
      if (!m) continue;
      const value = m[1].trim();
      for (const one of splitTopLevel(rule.selector, ',')) {
        const compounds = parseSelector(one.trim());
        if (!compounds.length) continue;
        if (!selectorMatches(node, compounds)) continue;
        const spec = selectorSpecificity(compounds);
        // Later rule wins a tie, matching the cascade.
        if (!winner || spec >= winner.spec) winner = { spec, value, selector: one.trim() };
      }
    }
  }
  return winner;
}

// ---- Node model ------------------------------------------------------

function modelNode(tagName, classes, parent) {
  const node = { tagName: String(tagName).toUpperCase(), classes: new Set(classes), parentNode: parent || null };
  return node;
}

// The prompt's <pre>, inside the system card's body, inside the card.
function systemBodyPre() {
  const card = modelNode('div', ['chat-msg', 'chat-msg--system']);
  const body = modelNode('div', ['chat-msg__body'], card);
  return modelNode('pre', ['chat-msg__system-body'], body);
}

// The prompt's <pre> as it sits inside an expanded SUBAGENT card: same
// classes plus the nested-transcript marker the renderer adds.
function nestedSystemBodyPre() {
  const card = modelNode('div', ['chat-msg', 'chat-msg--system', 'tool-card__subagent-msg']);
  const body = modelNode('div', ['chat-msg__body'], card);
  return modelNode('pre', ['chat-msg__system-body'], body);
}

// A fenced CODE BLOCK in an assistant bubble — the shape the markdown rule
// was written for and must keep handling.
function assistantCodeBlockPre() {
  const card = modelNode('div', ['chat-msg', 'chat-msg--assistant']);
  const body = modelNode('div', ['chat-msg__body'], card);
  return modelNode('pre', [], body);
}

// ---- Assertions ------------------------------------------------------

function main() {
  const transcriptCss = fs.readFileSync(TRANSCRIPT_CSS, 'utf8');
  const markdownCss = fs.readFileSync(MARKDOWN_CSS, 'utf8');
  const sheets = [transcriptCss, markdownCss];

  console.log('--- the expanded system prompt wraps ---');
  {
    const win = resolveProperty(sheets, systemBodyPre(), 'white-space');
    check('the top-level system prompt <pre> resolves to white-space: pre-wrap',
      !!win && win.value === 'pre-wrap',
      win ? win.value + '  (from `' + win.selector + '`)' : '(no declaration matched)');
  }

  {
    const win = resolveProperty(sheets, nestedSystemBodyPre(), 'white-space');
    check('the nested subagent system prompt <pre> resolves to white-space: pre-wrap',
      !!win && win.value === 'pre-wrap',
      win ? win.value + '  (from `' + win.selector + '`)' : '(no declaration matched)');
  }

  // The markdown code-block rule must NOT own the prompt: if it matched at a
  // higher specificity the prompt would lose its wrapping again.
  {
    const rules = splitRules(markdownCss);
    let offender = null;
    for (const rule of rules) {
      for (const one of splitTopLevel(rule.selector, ',')) {
        const compounds = parseSelector(one.trim());
        if (!compounds.length) continue;
        if (!selectorMatches(systemBodyPre(), compounds)) continue;
        if (/(?:^|;)\s*white-space\s*:\s*pre\s*;?/.test(rule.body) === false
          && !/(?:^|;)\s*white-space\s*:\s*pre\s*$/.test(rule.body)) continue;
        offender = one.trim();
      }
    }
    check('the markdown code-block rule no longer matches the system prompt <pre>',
      offender === null, offender || undefined);
  }

  console.log('--- code blocks keep their no-wrap rendering ---');
  {
    const win = resolveProperty(sheets, assistantCodeBlockPre(), 'white-space');
    check('a fenced code block in an assistant bubble still resolves to white-space: pre',
      !!win && win.value === 'pre',
      win ? win.value + '  (from `' + win.selector + '`)' : '(no declaration matched)');
  }

  console.log('--- the prompt still renders as the system-body <pre> ---');
  {
    const js = fs.readFileSync(TRANSCRIPT_JS, 'utf8');
    check('buildSystemPromptRow still marks the prompt body with the system-body class',
      /pre\.className = 'chat-msg__system-body'/.test(js));
    check('the system-body <pre> is inside the shared collapsed <details>',
      /details\.className = 'chat-msg__system-details'/.test(js)
      && /details\.appendChild\(pre\)/.test(js));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
assert.ok(true);
