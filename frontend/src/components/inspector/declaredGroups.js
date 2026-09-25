// Inspector Styles panel — Declared styles, grouped the way they were written.
//
// The CSSOM enumerates an element's inline style as *longhands*: a page that
// wrote `border: 1px solid #ddd` reports seventeen properties through
// `style.item(i)` — `border-top-width`, `border-right-width`, … down to five
// `border-image-*: initial` rows nobody typed. Listed one per row, that single
// declaration was a whole screen of the Declared list on a phone, and the one
// line the author actually wrote was nowhere in it.
//
// `style.cssText` is the browser's own serialisation of the same style, and it
// folds longhands back into the shortest shorthand it can (`border: 1px solid
// rgb(221, 221, 221)`). This module joins the two: each cssText declaration
// becomes one row, carrying the longhand names it stands for, so the list reads
// like the source while every name the rest of the panel keys on (the changed
// set, the computed "Declared" filter, the touch controls) is still the page's.
//
// The longhand list stays authoritative. A cssText declaration that claims no
// longhand the element really has (a stale snapshot, a property just removed)
// is dropped, and a longhand no declaration claims (a value written a moment
// ago, before the next read) is still listed on its own — so grouping can hide
// repetition but never a property.
//
// Pure: plain data in, plain data out, covered by
// scripts/test-inspector-declared-groups.js.
import { writesProperty } from './shorthand.js';

// parseCssText — `a: 1; b: url(x;y) !important` -> [{ prop, value, priority }].
// Splits on top-level semicolons only: a `;` inside quotes or parentheses (a
// data URL, a `content` string) belongs to its value.
export function parseCssText(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  const push = (end) => {
    const chunk = src.slice(start, end);
    const colon = chunk.indexOf(':');
    if (colon <= 0) return;
    let prop = chunk.slice(0, colon).trim();
    let value = chunk.slice(colon + 1).trim();
    if (!prop || !value) return;
    if (!prop.startsWith('--')) prop = prop.toLowerCase();
    let priority = '';
    const imp = /\s*!\s*important\s*$/i.exec(value);
    if (imp) {
      priority = 'important';
      value = value.slice(0, imp.index).trim();
    }
    out.push({ prop, value, priority });
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (ch === ';' && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(src.length);
  return out;
}

// groupDeclared — the rows the Declared list renders.
//
//   rows    the element's inline longhands, as the panel's model holds them:
//           [{ prop, value, priority }]
//   cssText the element's `style.cssText` from the same read
//
// Returns [{ prop, value, priority, longhands }] in cssText order, then any
// unclaimed longhand in its own order. `longhands` is empty for a row that is
// its own property, and lists the names a shorthand row stands for otherwise.
//
// Claims are made most-specific first: `border-radius` claims the four
// `border-*-radius` longhands before `border` gets a look, because `border`'s
// `border-` prefix would otherwise swallow them and hide the radius inside a row
// that does not set it.
export function groupDeclared(rows, cssText) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.prop);
  const decls = parseCssText(cssText);
  if (!decls.length) return list.map((r) => ({ ...r, longhands: [] }));
  const byName = new Map(list.map((r) => [r.prop, r]));
  const claimed = new Set();
  const groups = new Array(decls.length).fill(null);
  const order = decls
    .map((d, i) => i)
    .sort((a, b) => decls[b].prop.length - decls[a].prop.length || a - b);
  for (const i of order) {
    const d = decls[i];
    // The row the element holds under the declaration's own name, if any. It is
    // the fresher of the two (an edit updates the model before the next read),
    // so its value wins over the serialised one.
    const own = byName.get(d.prop);
    if (own && claimed.has(d.prop)) continue;
    const parts = list.filter((r) => r.prop !== d.prop && !claimed.has(r.prop) && writesProperty(d.prop, r.prop));
    if (!own && !parts.length) continue;
    if (own) claimed.add(d.prop);
    for (const r of parts) claimed.add(r.prop);
    groups[i] = {
      prop: d.prop,
      value: own ? own.value : d.value,
      priority: own ? (own.priority || '') : d.priority,
      longhands: parts.map((r) => r.prop)
    };
  }
  const out = groups.filter(Boolean);
  for (const r of list) {
    if (!claimed.has(r.prop)) out.push({ ...r, longhands: [] });
  }
  return out;
}

// memberNames — every property name a grouped row stands for: its own name
// first, then its longhands.
export function memberNames(row) {
  if (!row || !row.prop) return [];
  return [row.prop].concat(Array.isArray(row.longhands) ? row.longhands : []);
}

// changedKey — the name a grouped row is ranked by in the changed-first order:
// whichever of its members was changed most recently, or its own name when none
// was. A `border` row therefore rises when the box model edits `border-top-width`.
export function changedKey(row, changed) {
  const names = memberNames(row);
  if (!Array.isArray(changed) || !changed.length) return row && row.prop;
  let best = null;
  let bestAt = Infinity;
  for (const name of names) {
    const at = changed.indexOf(name);
    if (at !== -1 && at < bestAt) { best = name; bestAt = at; }
  }
  return best || (row && row.prop);
}

// groupChanged — whether any member of a grouped row was changed this session.
export function groupChanged(row, changed) {
  if (!Array.isArray(changed) || !changed.length) return false;
  return memberNames(row).some((name) => changed.includes(name));
}

// findDeclaration — the serialised declaration for one property name, or null.
// This is how an edit of a shorthand row finds the value it replaces (for the
// undo receipt): the longhand list has no row by that name.
export function findDeclaration(cssText, prop) {
  const name = String(prop == null ? '' : prop).trim();
  if (!name) return null;
  const key = name.startsWith('--') ? name : name.toLowerCase();
  return parseCssText(cssText).find((d) => d.prop === key) || null;
}
