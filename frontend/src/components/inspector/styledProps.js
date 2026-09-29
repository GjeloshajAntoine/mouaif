// Inspector Styles panel — "which properties is this element actually styled
// with, and by what?"
//
// The Computed list is every property the browser resolves (~400 on a typical
// element), and nearly all of them are browser defaults: `accent-color: auto`,
// `anchor-name: none`, `animation-delay: 0s`… Opening the panel on that wall is
// what made it read as nonsense — the handful of values a stylesheet really set
// were somewhere in it, indistinguishable from the rest, and the only place the
// cascade was named was the collapsed **Matched rules** section.
//
// This module answers the question from data the panel already has (the
// normalized matched rules, see matchedRules.js, plus the element's inline
// declarations and this session's edits): the set of computed rows an author
// actually styled, each with the *source* that supplied it — `element.style`,
// the rule's selector, or `inherited from div.card`. The Computed list's default
// "Styled" filter is this set, and every row can say where its value comes from.
//
// Pure: plain data in, plain data out, so
// `scripts/test-inspector-styled-props.js` covers it without a browser.
import { writesProperty } from './shorthand.js';

// INHERITED — the properties CSS inherits by default. A rule on an ancestor
// only styles the selected element through one of these (a `padding` on the
// parent does nothing to the child), so an inherited rule contributes only its
// inheritable declarations. Custom properties (`--x`) always inherit.
export const INHERITED = new Set([
'color', 'cursor', 'direction', 'font', 'font-family', 'font-feature-settings',
'font-kerning', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style',
'font-variant', 'font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric',
'font-weight', 'hyphens', 'letter-spacing', 'line-height', 'list-style',
'list-style-image', 'list-style-position', 'list-style-type', 'orphans', 'quotes',
'tab-size', 'text-align', 'text-align-last', 'text-indent', 'text-shadow',
'text-transform', 'text-rendering', 'visibility', 'white-space', 'widows',
'word-break', 'word-spacing', 'overflow-wrap', 'word-wrap', 'caret-color',
'accent-color', 'color-scheme', 'fill', 'stroke', 'pointer-events', 'writing-mode',
'-webkit-text-fill-color', '-webkit-font-smoothing'
]);

function isReset(value) {
return String(value == null ? '' : value).trim().toLowerCase() === 'initial';
}

export function isInherited(name) {
const n = String(name || '').trim().toLowerCase();
if (!n) return false;
if (n.startsWith('--')) return true;
if (INHERITED.has(n)) return true;
// A longhand of an inheritable shorthand (`font-*`, `list-style-*`) inherits too.
return n.startsWith('font-') || n.startsWith('list-style-');
}

// styledSources — every declared name, mapped to the source that supplies it.
//
// `rules` is the normalized list (element.style first, then the element's own
// rules most specific first, then inherited rules nearest ancestor first), so the
// first source seen for a name is the one that wins in the common case. The
// `!important` ordering is not modelled: this is a label that says where to
// look, not a cascade engine, and Matched rules still shows every candidate.
//
// Browser-default (user-agent) rules and disabled declarations are skipped: the
// point is "what did an author style", and a UA `display: block` is the kind of
// row this view exists to hide.
export function styledSources(input) {
const o = input || {};
const out = new Map();
const add = (name, source) => {
const key = String(name || '').trim().toLowerCase();
if (key && !out.has(key)) out.set(key, source);
};
for (const row of o.changed || []) add(row, { label: 'changed here', kind: 'changed' });
for (const row of o.inline || []) {
if (!row || !row.prop || isReset(row.value)) continue;
add(row.prop, { label: 'element.style', kind: 'inline' });
}
for (const rule of o.rules || []) {
if (!rule || rule.group === 'user-agent') continue;
const inherited = !!rule.inherited;
const label = inherited
? 'inherited from ' + rule.inherited
: (rule.origin === 'inline' ? 'element.style' : String(rule.selector || 'rule'));
const decls = (rule.all || rule.props || []).filter((p) => p && !p.disabled && p.name);
const names = decls.map((p) => String(p.name).toLowerCase());
for (const p of decls) {
// `initial` is how a shorthand's unwritten longhands serialise
// (`background: #fff` stores `background-image: initial`, …): a reset the
// author never typed, which would list every background-* row as "styled".
if (isReset(p.value)) continue;
// The CSS domain lists a shorthand *and* its explicit longhands (the
// unwritten ones are `implicit` and dropped by matchedRules.js). When the
// longhands are there they are the precise answer, so the shorthand is not
// expanded as well — it would claim `background-image` for `background: #fff`.
const name = String(p.name).toLowerCase();
if (SHORTHANDS.has(name) && names.some((n) => n !== name && expands(name, n))) continue;
if (inherited && !isInherited(p.name)) continue;
add(p.name, { label, kind: inherited ? 'inherited' : (rule.origin === 'inline' ? 'inline' : 'rule') });
}
}
return out;
}

// SHORTHANDS — the declared names that stand for several computed longhands.
// Only these are expanded: `writesProperty` is a prefix test, and on a
// non-shorthand it over-matches (`color` would claim `color-scheme`, `border`
// would claim `border-collapse`).
export const SHORTHANDS = new Set([
'margin', 'margin-block', 'margin-inline', 'padding', 'padding-block', 'padding-inline',
'inset', 'inset-block', 'inset-inline', 'gap', 'border', 'border-top', 'border-right',
'border-bottom', 'border-left', 'border-block', 'border-inline', 'border-width',
'border-style', 'border-color', 'border-radius', 'border-image', 'outline', 'background',
'font', 'flex', 'flex-flow', 'grid', 'grid-template', 'grid-area', 'grid-row',
'grid-column', 'place-items', 'place-content', 'place-self', 'list-style', 'transition',
'animation', 'overflow', 'text-decoration', 'columns', 'column-rule', 'mask',
'scroll-margin', 'scroll-padding', 'text-emphasis', 'container', 'contain-intrinsic-size'
]);
// Names that share a shorthand's prefix without being one of its longhands.
const NOT_LONGHANDS = {
border: ['border-collapse', 'border-spacing'],
overflow: ['overflow-wrap', 'overflow-anchor', 'overflow-clip-margin'],
flex: ['flex-direction', 'flex-wrap', 'flex-flow'],
background: ['background-blend-mode'],
font: ['font-palette', 'font-synthesis', 'font-optical-sizing', 'font-feature-settings', 'font-variation-settings'],
mask: ['mask-type']
};
function expands(shorthand, longhand) {
if (!SHORTHANDS.has(shorthand)) return false;
const skip = NOT_LONGHANDS[shorthand];
if (skip && skip.includes(longhand)) return false;
return writesProperty(shorthand, longhand);
}

// sourceFor — the source of one computed row. A computed row is always a
// longhand (`padding-top`), while a rule may declare the shorthand (`padding`),
// so a direct hit is tried first and then every declared shorthand that writes it.
export function sourceFor(sources, prop) {
if (!sources || !prop) return null;
const key = String(prop).trim().toLowerCase();
if (sources.has(key)) return sources.get(key);
for (const [name, source] of sources) {
if (expands(name, key)) return source;
}
return null;
}

// styledRows — the computed rows an author styled, in the order given, each
// carrying its `source`. Also returns the name set so the filter can use it.
export function styledRows(computed, sources) {
const rows = [];
const names = new Set();
for (const row of computed || []) {
if (!row || !row.prop) continue;
const source = sourceFor(sources, row.prop);
if (!source) continue;
rows.push(row);
names.add(row.prop);
}
return { rows, names };
}
