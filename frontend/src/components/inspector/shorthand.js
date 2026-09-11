// Inspector shorthand write-back — the shortest form, and the honest fallback.
//
// A fan-out view (valueShapes.js) lets the user drag four sides, and what gets
// written has to be both the shortest valid form and something the page reads
// back as the same four values:
//
//   padding: 10px 10px 10px 10px   ->   padding: 10px
//   padding: 10px 20px 10px 20px   ->   padding: 10px 20px
//   padding: 4px 8px 12px 8px      ->   padding: 4px 8px 12px
//
// but not everything may be collapsed. A side written as a custom property
// reference (`var(--space-3)`) cannot legally join a shorthand's other sides,
// because a `var()` that fails to resolve invalidates the *whole* shorthand at
// computed-value time — turning one lost value into four. A side whose value is
// itself several tokens (`calc(1px + 2px)`) is a different hazard: the
// whitespace it contains is not a separator, so joining it would split it.
//
// This module therefore returns two things from one call:
//
//   shorthandFor('padding', values) -> {
//     ok: true, form: 'shorthand', value: '10px 14px 18px',
//     longhands: { 'padding-top': '10px', ... }, reason: ''
//   }
//
// `value` is what to write when the property is one declaration; `longhands` is
// what to write when it is not. `form` says which, so a caller never has to
// guess — and a fan-out edit is one receipt entry either way, because the
// caller records the change against the property it was editing.
//
// Everything is pure. Nothing here writes to the page.
import { formatNumber } from './valueKinds.js';
import { sidesFor } from './valueShapes.js';
// UNSAFE_FUNCTIONS — a side holding one of these must not be folded into a
// shorthand. `var()` is the important one: an unresolvable custom property
// makes the whole shorthand invalid at computed-value time, so collapsing four
// sides into one would spread a single missing variable across all four.
const UNSAFE_FUNCTIONS = /(^|\s|^[-a-z]*\()(?:var|env|attr)\(/i;
// SLASH_PROPERTIES — properties whose shorthand syntax has an optional `/` form
// (`border-radius: 1px / 2px`). Their one-value and two-value forms mean
// something else, so they are never written as a collapsed pair.
const SLASH_PROPERTIES = new Set(['border-radius']);
// separatorFor — how a property's sides are laid out in its shorthand. Four-side
// properties are space-separated; a two-side property is the same. This is a
// named constant rather than a literal so the one place that needs a different
// separator (`border-radius` with a slash) can say so.
function separatorFor(property) {
const prop = String(property || '').trim().toLowerCase();
return SLASH_PROPERTIES.has(prop) ? ' / ' : ' ';
}
// isSafeToken — whether a side's value can legally sit in a shorthand.
//
// The rules, in order of how badly they bite:
//   * a `var()` / `env()` / `attr()` is refused (see UNSAFE_FUNCTIONS);
//   * a value containing top-level whitespace that is not part of one function
//     is refused, because joining it would re-split it into two sides;
//   * a CSS-wide keyword is allowed: `padding: inherit` is valid and is exactly
//     what the user asked for by picking it.
function isSafeToken(raw) {
const value = String(raw == null ? '' : raw).trim();
if (!value) return false;
if (UNSAFE_FUNCTIONS.test(value)) return false;
// A single token, or a single function call whose parentheses are balanced and
// whose content has no *top-level* space (a space inside a function is fine:
// `calc(1px + 2px)` is one token to the shorthand parser only when it is
// parenthesised, and it is).
let depth = 0;
for (const ch of value) {
if (ch === '(') depth++;
else if (ch === ')') depth--;
else if (/\s/.test(ch) && depth === 0) return false;
}
return depth === 0;
}
// collapse — the shortest valid shorthand for four (or two) side values, or
// `null` when the values cannot be collapsed safely.
//
// The CSS rules, which are the whole of the arithmetic:
//   * all equal                  -> one value
//   * top == bottom, left == right -> two values (top right)
//   * left == right              -> three values (top right bottom)
//   * otherwise                  -> four values, in full
export function collapse(values, count) {
const v = (values || []).map((x) => String(x == null ? '' : x).trim());
if (v.length !== count || count < 2) return null;
if (v.some((x) => !x)) return null;
if (count === 2) return v[0] === v[1] ? v[0] : v.join(' ');
// `border-radius`'s two-value form is `1px / 2px` (a different radius on each
// axis), so a pair is never its "shortest" form.
if (v[1] === v[3] && v[0] === v[2]) {
return v[0] === v[1] ? v[0] : v[0] + ' ' + v[1];
}
if (v[1] === v[3]) return v[0] + ' ' + v[1] + ' ' + v[2];
return v.join(' ');
}
// shorthandFor — what to write for a fan-out property, and in which form.
//
// Returns `{ ok, form, value, longhands, reason }`:
//   * `form: 'shorthand'` — write `value` to `property` (the common case);
//   * `form: 'longhands'` — write each of `longhands` instead, because the sides
//     cannot legally be folded (a `var()` side, or a value that would re-split);
//   * `ok: false` — the property is not a fan-out one, with the reason.
export function shorthandFor(property, values) {
const prop = String(property || '').trim().toLowerCase();
const def = sidesFor(prop);
if (!def) return { ok: false, form: '', value: '', longhands: {}, reason: 'not a shorthand property' };
const sides = values || {};
const raw = {};
const missing = [];
for (const s of def) {
const v = String(sides[s.key] == null ? '' : sides[s.key]).trim();
if (!v) missing.push(s.key);
raw[s.key] = v;
}
if (missing.length) {
return {
ok: false,
form: '',
value: '',
longhands: raw,
reason: 'no value for ' + missing.join(', ')
};
}
// The longhand fallback is always available, and it is what gets written when a
// shorthand is not safe.
const longhands = {};
for (const s of def) longhands[s.longhand] = raw[s.key];
const unsafe = def.filter((s) => !isSafeToken(raw[s.key]));
if (unsafe.length) {
return {
ok: true,
form: 'longhands',
value: '',
longhands,
reason: 'a ' + (UNSAFE_FUNCTIONS.test(raw[unsafe[0].key]) ? 'custom property' : 'multi-part value')
+ ' cannot join a shorthand, so the ' + def.length + ' sides are written as longhands'
};
}
const collapsed = collapse(def.map((s) => raw[s.key]), def.length);
if (!collapsed) {
return { ok: true, form: 'longhands', value: '', longhands, reason: 'the sides could not be collapsed' };
}
// `border-radius`'s space-separated pair means "same radius on both axes",
// which is a different declaration from the two-value shorthand the user
// dragged. Where the pair is what the user asked for, the longhands keep it
// literal.
if (SLASH_PROPERTIES.has(prop) && def.length === 4) {
const parts = collapsed.split(' ');
if (parts.length === 2) {
return { ok: true, form: 'longhands', value: '', longhands, reason: 'a two-value border-radius is the slash form, so the corners are written literally' };
}
}
return { ok: true, form: 'shorthand', value: collapsed, longhands, reason: '' };
}
// shorthandWrites — the writes a fan-out edit produces, as a list, so a caller
// can apply them in one pass and record them as one receipt entry.
//
//   [{ prop: 'padding', value: '10px 14px' }]
//   [{ prop: 'padding-top', value: 'var(--a)' }, ...]
export function shorthandWrites(property, values) {
const result = shorthandFor(property, values);
if (!result.ok) return [];
if (result.form === 'shorthand') return [{ prop: property, value: result.value }];
return Object.entries(result.longhands).map(([prop, value]) => ({ prop, value }));
}
// toRoot — a pixel number as the page's own `rem`, using the real root font size
// the panel read (`bases.root`), never a hard-coded 16.
//
// Returns `null` when the root size is unknown, which is the honest answer: the
// caller keeps the px value rather than writing a rem built on a guess.
export function toRoot(px, rootFontSize) {
const n = Number(px);
const root = Number(rootFontSize);
if (!Number.isFinite(n) || !Number.isFinite(root) || root <= 0) return null;
return n / root;
}
// fromRoot — the inverse, for reading a rem value back as pixels.
export function fromRoot(rem, rootFontSize) {
const n = Number(rem);
const root = Number(rootFontSize);
if (!Number.isFinite(n) || !Number.isFinite(root) || root <= 0) return null;
return n * root;
}
// asRem — `16` and a 20 px root -> `0.8rem`. Used by the fan-out's write-back
// when the property is already expressed in rem, so the unit survives the drag.
export function asRem(px, rootFontSize) {
const rem = toRoot(px, rootFontSize);
if (rem == null) return null;
return formatNumber(rem) + 'rem';
}
// asPx — the inverse, so a rem value dragged on a px rail lands back in rem.
export function asPx(rem, rootFontSize) {
const px = fromRoot(rem, rootFontSize);
if (px == null) return null;
return formatNumber(px) + 'px';
}
