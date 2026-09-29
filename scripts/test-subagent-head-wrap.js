// Regression test: a subagent card's head keeps its task on one line and
// its two extra chips fully readable.
//
// The head is one flex row: chevron · `Subagent` · agent chip · task ·
// cost · status dot. At 375 px a normal delegation leaves the task with
// almost nothing (chip 54 px + cost 42 px), so the task is the part that
// gives up room: it stays a single clipped line, exactly like every other
// tool card, with the full text kept on `title`.
//
// The other two text parts must NOT be clipped — they are the reason the
// card exists in a transcript full of tool rows:
//   - the agent chip is the ONLY place the dispatched agent's name appears,
//     so a `revie…` chip makes an `@reviewer` dispatch unreadable;
//   - the cost is the running figure the user is watching.
//
// A DOM stub cannot evaluate CSS, so — like
// scripts/test-subagent-expand-state.js — the cascade is resolved from the
// real stylesheet against a modelled head, in both the collapsed AND
// expanded states (the expanded state is where the generic
// `.tool-card.is-expanded .tool-card__args` rule lives).

const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '../frontend/src/tool-cards.css');

// ---- Minimal CSS cascade resolver ------------------------------------
//
// Covers the selector constructs the head rules use: descendant compounds
// made of `.class`, `:not(<compound>)`, `:where(<compound>)` and `:empty`.

function splitRules(css) {
  const out = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

function parseCompound(text) {
  const tokens = [];
  let i = 0;
  const readInner = (openIdx) => {
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
      if (name === 'empty') { tokens.push({ kind: 'empty' }); i = after; continue; }
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
  return selector.split(/\s+/).filter(Boolean).map(parseCompound);
}

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

function compoundMatches(node, tokens) {
  for (const t of tokens) {
    if (t.kind === 'class' && !node.classes.has(t.name)) return false;
    if (t.kind === 'tag' && node.tagName !== t.name) return false;
    if (t.kind === 'empty' && node.childElementCount !== 0) return false;
    if (t.kind === 'pseudo' && t.name !== 'empty') return false;
    if (t.kind === 'not') {
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
    if (t.kind === 'class' || t.kind === 'empty') s += 1;
    if (t.kind === 'pseudo') s += 1;
    if (t.kind === 'not') {
      const inner = splitTopLevel(t.inner, ',').map((x) => x.trim()).filter(Boolean);
      s += Math.max(0, ...inner.map((sel) => countSpecificity(parseCompound(sel))));
    }
  }
  return s;
}

function selectorSpecificity(compounds) {
  return compounds.reduce((sum, c) => sum + countSpecificity(c), 0);
}

// ---- Node model ------------------------------------------------------

function modelNode(tagName, classes, parent) {
  return { tagName: String(tagName).toUpperCase(), classes: new Set(classes), childElementCount: 1, parentNode: parent || null };
}

// `.tool-card__head > .tool-card__args` inside a card, with or without the
// subagent marker. `expanded` toggles `is-expanded` — the state the generic
// `.tool-card.is-expanded .tool-card__args` rule targets.
function headArgs({ subagent, expanded }) {
  const cardClasses = ['tool-card', 'tool-card--result'];
  if (subagent) cardClasses.push('tool-card--subagent');
  if (expanded) cardClasses.push('is-expanded');
  const card = modelNode('div', cardClasses);
  const head = modelNode('span', ['tool-card__head'], card);
  return modelNode('pre', ['tool-card__args'], head);
}

function costLabel() {
  const card = modelNode('div', ['tool-card', 'tool-card--subagent']);
  const head = modelNode('span', ['tool-card__head'], card);
  return modelNode('span', ['tool-card__cost'], head);
}

function agentChip() {
  const card = modelNode('div', ['tool-card', 'tool-card--subagent']);
  const head = modelNode('span', ['tool-card__head'], card);
  return modelNode('span', ['tool-card__agent'], head);
}

// Resolve the winning declaration for one property against `node`,
// comparing by specificity and breaking ties by source order.
function resolveProp(css, node, prop) {
  let winner = null;
  for (const rule of splitRules(css)) {
    if (!rule.selector.includes('.tool-card')) continue;
    const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)');
    const m = re.exec(rule.body);
    if (!m) continue;
    for (const one of splitTopLevel(rule.selector, ',')) {
      const compounds = parseSelector(one.trim());
      if (!compounds.length) continue;
      if (!selectorMatches(node, compounds)) continue;
      const spec = selectorSpecificity(compounds);
      if (!winner || spec >= winner.spec) winner = { spec, value: m[1].trim(), selector: one.trim() };
    }
  }
  return winner;
}

const valueOf = (css, node, prop) => {
  const w = resolveProp(css, node, prop);
  return w ? w.value : '(unset)';
};

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

function main() {
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  // ---- 1. The task stays on the head's single line -------------------
  for (const expanded of [false, true]) {
    const state = expanded ? 'expanded' : 'collapsed';
    const args = headArgs({ subagent: true, expanded });
    check('[' + state + '] the subagent task stays on one line',
      valueOf(css, args, 'white-space') === 'nowrap', valueOf(css, args, 'white-space'));
    check('[' + state + '] the task still shares the head row',
      /^1\s+1\s+auto$/.test(valueOf(css, args, 'flex')), valueOf(css, args, 'flex'));
  }
  {
    const card = modelNode('div', ['tool-card', 'tool-card--subagent']);
    const head = modelNode('span', ['tool-card__head'], card);
    check('the subagent head does not wrap its lines',
      valueOf(css, head, 'flex-wrap') === '(unset)', valueOf(css, head, 'flex-wrap'));
  }

  // ---- 2. The agent chip and the cost never truncate -----------------
  {
    const chip = agentChip();
    check('the agent chip may use the full head width',
      valueOf(css, chip, 'max-width') === '100%', valueOf(css, chip, 'max-width'));
    check('the agent chip never shrinks away',
      valueOf(css, chip, 'flex') === '0 0 auto', valueOf(css, chip, 'flex'));
  }
  {
    const cost = costLabel();
    check('the cost never shrinks away',
      valueOf(css, cost, 'flex') === '0 0 auto', valueOf(css, cost, 'flex'));
    check('the cost is never ellipsized',
      valueOf(css, cost, 'text-overflow') === 'clip', valueOf(css, cost, 'text-overflow'));
    check('the cost is not hidden when it overflows',
      valueOf(css, cost, 'overflow') === 'visible', valueOf(css, cost, 'overflow'));
  }

  // ---- 3. Every other tool card is untouched -------------------------
  for (const expanded of [false, true]) {
    const state = expanded ? 'expanded' : 'collapsed';
    const args = headArgs({ subagent: false, expanded });
    check('[generic ' + state + '] the argument stays on one line',
      valueOf(css, args, 'white-space') === 'nowrap', valueOf(css, args, 'white-space'));
    check('[generic ' + state + '] the argument still ellipsizes',
      valueOf(css, args, 'text-overflow') === 'ellipsis', valueOf(css, args, 'text-overflow'));
  }
  {
    const card = modelNode('div', ['tool-card', 'tool-card__result']);
    const head = modelNode('span', ['tool-card__head'], card);
    check('a generic head does not wrap its lines',
      valueOf(css, head, 'flex-wrap') === '(unset)', valueOf(css, head, 'flex-wrap'));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main();
