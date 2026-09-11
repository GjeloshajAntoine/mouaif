// Inspector value index — what values does this page actually use?
//
// The edit sheet can already rewrite a value in another type or unit (see
// valueKinds.js). What it cannot do is tell the user which values belong to
// *this* page's scale: whether `14px` is a one-off or the value the rest of the
// design already uses, and which design tokens resolve to it.
//
// This module answers that from data the panel already has — the normalized
// matched rules (`matchedRules.js`) and the computed style read — so the index
// costs no extra CDP call:
//
//   buildValueIndex({ rules, computed }) -> {
//     props: { padding: { values: [{value, count, selector, origin, inherited}], uses },
//              '--space-3': {...} },
//     tokens: [{ name, value, selector }],
//     computed: { padding: '14px' }
//   }
//
// and then, per property:
//
//   valuesFor(index, 'padding')  -> most-used first, with the evidence
//   tokensFor(index, 'padding')  -> the tokens whose value is valid here
//   scaleFor(index, 'padding')   -> { unit, values, step } — the page's own steps
//
// Everything is pure: plain objects in, plain objects out.

import { classify } from './valueKinds.js';

// MAX_VALUES — values kept per property. The list is a suggestion list, not an
// inventory: past this the long tail says nothing useful about the scale, and a
// phone-sized chip row can only show a handful anyway. The dropped count is
// reported so nothing is silently lost.
export const MAX_VALUES = 12;
export const MAX_TOKENS = 8;

// valueKey — a value's identity for counting. Whitespace runs collapse so
// `14px   ` and `14px` are one entry, and matching is case-insensitive for the
// keyword values (`Auto` and `auto` are the same declaration).
export function valueKey(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
}

// parseNumber — `14px` -> `{ n: 14, unit: 'px', step: 1 }`. `step` is the
// number of decimal places', used to compare numbers without float noise. The
// unit is lower-cased; a bare number has ''.
export function parseNumber(value) {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(String(value == null ? '' : value).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  const decimals = (m[1].split('.')[1] || '').length;
  return { n, unit, decimals };
}

// gcd — greatest common divisor of two numbers, scaled by `factor` so a decimal
// scale (`1.5`, `3`) is handled as integers rather than rounding to 1.
function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) { const t = x % y; x = y; y = t; }
  return x;
}

// numericScale — the page's own steps for a set of numeric values.
//
// The step is the GCD of the values: a scale of 4/8/12/16 px gives 4, and a
// scale of 1.5/3/4.5 gives 1.5. It is reported only when at least two distinct
// numbers exist — one value says nothing about a scale — and only when every
// value shares the dominant unit, because mixing `px` and `%` has no single step.
export function numericScale(entries) {
  const byUnit = new Map();
  for (const e of entries || []) {
    const p = parseNumber(e && e.value);
    if (!p || !Number.isFinite(p.n)) continue;
    if (!byUnit.has(p.unit)) byUnit.set(p.unit, { numbers: new Set(), decimals: 0, count: 0 });
    const bucket = byUnit.get(p.unit);
    bucket.numbers.add(p.n);
    bucket.decimals = Math.max(bucket.decimals, p.decimals);
    bucket.count += (e.count || 1);
  }
  if (!byUnit.size) return null;
  // The unit the page uses most wins; a tie falls back to the one with the
  // smallest numbers, which is the more likely design scale.
  let best = null;
  for (const [unit, bucket] of byUnit) {
    const score = bucket.count + bucket.numbers.size / 100;
    if (!best || score > best.score) best = { unit, bucket, score };
  }
  const numbers = Array.from(best.bucket.numbers).sort((a, b) => a - b);
  if (numbers.length < 2) return { unit: best.unit, values: numbers, step: null, decimals: best.bucket.decimals };
  const factor = Math.pow(10, best.bucket.decimals);
  const scaled = numbers.map((n) => Math.round(n * factor));
  let step = scaled[0];
  for (let i = 1; i < scaled.length; i++) step = gcd(step, scaled[i]);
  return {
    unit: best.unit,
    values: numbers,
    step: step > 0 ? step / factor : null,
    decimals: best.bucket.decimals
  };
}

// addValue — record one declaration in the index. The first selector seen wins
// because `normalizeMatchedRules` returns the cascade in reading order (most
// specific first), so the recorded selector is the rule that actually supplies
// the value.
function addValue(bucket, value, rule) {
  const key = valueKey(value);
  if (!key) return;
  bucket.uses++;
  let entry = bucket.values.find((v) => v.key === key);
  if (!entry) {
    entry = {
      key,
      value: String(value).trim().replace(/\s+/g, ' '),
      count: 0,
      selector: '',
      origin: 'regular',
      inherited: ''
    };
    bucket.values.push(entry);
  }
  entry.count++;
  if (!entry.selector && rule) {
    entry.selector = rule.selector || '';
    entry.origin = rule.origin || 'regular';
    entry.inherited = rule.inherited || '';
  }
}

// buildValueIndex — the one entry point. `rules` is the normalized list from
// `normalizeMatchedRules` (so it already carries origins, inheritance and the
// cascade order); `computed` is the element's resolved values (`{prop, value}`),
// used only to mark which value the element currently resolves to and to type
// custom properties.
export function buildValueIndex(input) {
  const i = input || {};
  const props = {};
  const tokens = [];

  for (const rule of i.rules || []) {
    if (!rule) continue;
    for (const p of rule.props || []) {
      const name = String((p && p.name) || '').trim().toLowerCase();
      if (!name) continue;
      if (name.startsWith('--')) {
        // A custom property is a token, not a property's value: collect it
        // separately so it never shows up as a candidate value for `padding`.
        const existing = tokens.find((t) => t.name === name);
        if (existing) existing.count++;
        else tokens.push({ name, value: String(p.value || '').trim(), selector: rule.selector || '', count: 1 });
        continue;
      }
      if (!props[name]) props[name] = { values: [], uses: 0, computed: '' };
      addValue(props[name], p.value, rule);
    }
  }

  for (const row of i.computed || []) {
    const name = String((row && row.prop) || '').trim().toLowerCase();
    if (!name) continue;
    if (name.startsWith('--')) {
      // Computed styles carry custom properties too, which is the reliable way
      // to learn a token's resolved value (the declared text may be `var(...)`).
      const existing = tokens.find((t) => t.name === name);
      if (existing) existing.resolved = String(row.value || '').trim();
      else tokens.push({ name, value: String(row.value || '').trim(), selector: 'computed', count: 0, resolved: String(row.value || '').trim() });
      continue;
    }
    if (!props[name]) props[name] = { values: [], uses: 0, computed: '' };
    props[name].computed = String(row.value || '').trim();
  }

  return { props, tokens };
}

// valuesFor — the page's values for one property, most-used first.
//
// Ties break alphabetically so the order is stable between renders (a chip row
// that reshuffles while a network read lands is worse than an arbitrary order),
// and the value the element currently resolves to is flagged so the sheet can
// show it as "already in force".
export function valuesFor(index, property, limit) {
  const prop = String(property || '').trim().toLowerCase();
  const bucket = index && index.props && index.props[prop];
  if (!bucket) return [];
  const computedKey = valueKey(bucket.computed);
  const rows = bucket.values.map((v) => ({
    value: v.value,
    count: v.count,
    selector: v.selector,
    origin: v.origin,
    inherited: v.inherited,
    isCurrent: computedKey !== '' && v.key === computedKey
  }));
  rows.sort((a, b) => (b.count - a.count) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const max = limit || MAX_VALUES;
  return rows.slice(0, max);
}

// FAMILY_WORDS — the words that identify what a token is *for*, matched on the
// segments of its name (`--radius-md` -> radius, `--space-3` -> space). Used to
// keep a suggestion honest: `--radius-md: 8px` is a length, so the type check
// alone would happily offer it as a `padding` value, which is not a suggestion
// anyone wants. A token whose name carries no family word (like `--brand`) is
// left to the type check.
export const FAMILY_WORDS = {
  space: ['space', 'spacing', 'gap', 'pad', 'padding', 'margin', 'inset', 'gutter'],
  radius: ['radius', 'corner', 'rounded', 'round'],
  color: ['color', 'colour', 'brand', 'bg', 'background', 'fg', 'foreground', 'accent', 'surface'],
  font: ['font', 'type', 'text', 'leading', 'weight'],
  motion: ['duration', 'delay', 'ease', 'easing', 'transition', 'animation', 'motion', 'speed']
};

// PROPERTY_FAMILY — the family a property belongs to, for the names above. A
// property that is not listed is not name-filtered at all (only type-checked),
// because guessing a family for an unknown property is how wrong suggestions
// get made.
export const PROPERTY_FAMILY = {
  padding: 'space', margin: 'space', gap: 'space', 'row-gap': 'space', 'column-gap': 'space',
  inset: 'space', top: 'space', right: 'space', bottom: 'space', left: 'space',
  width: 'space', height: 'space', 'min-width': 'space', 'min-height': 'space',
  'max-width': 'space', 'max-height': 'space',
  'border-radius': 'radius',
  color: 'color', 'background-color': 'color', 'border-color': 'color',
  'font-size': 'font', 'line-height': 'font', 'font-family': 'font',
  'letter-spacing': 'font', 'font-weight': 'font',
  'transition-duration': 'motion', 'transition-delay': 'motion',
  'transition-timing-function': 'motion', 'animation-duration': 'motion', 'animation-delay': 'motion'
};

// tokenFamily — the family a token's name declares, or '' when it declares none.
export function tokenFamily(name) {
  const segments = String(name || '').toLowerCase().replace(/^--/, '').split(/[-_]/).filter(Boolean);
  for (const [family, words] of Object.entries(FAMILY_WORDS)) {
    if (segments.some((s) => words.includes(s))) return family;
  }
  return '';
}

// tokenFitsProperty — whether a token should be offered for a property. The type
// check is the caller's (see tokensFor); this is the name check, and it only
// ever *excludes*: a token whose name declares a different family than the
// property's is not a suggestion, however valid its value happens to be.
export function tokenFitsProperty(property, tokenName) {
  const propFamily = PROPERTY_FAMILY[String(property || '').trim().toLowerCase()];
  const fam = tokenFamily(tokenName);
  if (!propFamily || !fam) return true;
  return fam === propFamily;
}

// tokensFor — the design tokens whose value is a valid value for this property.
//
// "Valid" is decided by the same classifier the type switch uses (see
// valueKinds.js): a length token is offered for `padding`, a colour token for
// `color`, and a token holding something else is left out rather than offered
// and rejected. The resolved value is preferred over the declared text, because
// a token declared as `var(--space-base)` is only useful once it is a number.
export function tokensFor(index, property, limit) {
  const prop = String(property || '').trim().toLowerCase();
  if (!prop) return [];
  const bucket = index && index.props && index.props[prop];
  const wanted = bucket && bucket.values.length
    ? classify(prop, bucket.values[0].value).kind
    : (bucket && bucket.computed ? classify(prop, bucket.computed).kind : null);
  const out = [];
  for (const t of (index && index.tokens) || []) {
    const resolved = t.resolved || t.value;
    if (!resolved) continue;
    // A `var(...)` declaration that never resolved cannot be offered: we would be
    // showing a token without knowing what it is worth.
    if (/^var\(/i.test(resolved)) continue;
    if (!tokenFitsProperty(prop, t.name)) continue;
    if (wanted && classify(prop, resolved).kind !== wanted) continue;
    out.push({ name: t.name, value: resolved, declared: t.value, selector: t.selector, count: t.count || 0 });
  }
  out.sort((a, b) => (b.count - a.count) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out.slice(0, limit || MAX_TOKENS);
}

// scaleFor — the numeric scale for one property, or null when there is not one.
export function scaleFor(index, property) {
  const rows = valuesFor(index, property, MAX_VALUES);
  if (rows.length < 2) return null;
  return numericScale(rows);
}

// scaleNote — a one-line description of the scale, for the sheet's header. The
// count of uses is what makes it evidence rather than trivia.
export function scaleNote(scale) {
  if (!scale || !scale.values || scale.values.length < 2) return '';
  const unit = scale.unit || '';
  const steps = scale.step ? String(scale.step) + unit : 'no common step';
  return scale.values.length + ' values on this page · steps of ' + steps;
}

// siblingValues — values the sibling elements use for this property.
//
// `rows` is what the caller read from the page: one entry per sibling with the
// property's declared value (`{ value, label }`), so this is pure grouping. The
// result names the element each value comes from, because "the 2nd
// section.input-section uses 16px" is actionable in a way "16px" is not.
export function siblingValues(rows, property) {
  const prop = String(property || '').trim().toLowerCase();
  const out = [];
  for (const row of rows || []) {
    if (!row || row.prop !== prop) continue;
    if (!row.value) continue;
    const key = valueKey(row.value);
    let entry = out.find((e) => e.key === key);
    if (!entry) {
      entry = { key, value: String(row.value).trim(), count: 0, labels: [] };
      out.push(entry);
    }
    entry.count++;
    if (row.label && !entry.labels.includes(row.label)) entry.labels.push(row.label);
  }
  out.sort((a, b) => (b.count - a.count) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return out.map((e) => ({ value: e.value, count: e.count, labels: e.labels }));
}
