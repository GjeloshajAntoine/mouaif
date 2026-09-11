// Inspector value shapes — the extra views a value kind needs beyond one rail.
//
// The rail (valueRail.js) is the right changer for *a* number. It is the wrong
// one for a colour, which is three numbers that only mean something together; for
// a four-sided shorthand, which is four numbers that are one declaration; for a
// function list, which is an ordered list of rail-shaped arguments; and for an
// enum, which is not a number at all.
//
// This module is the pure part of the K2–K4 views: what shape a declaration has,
// how its parts are derived, and how they are written back. It is deliberately
// the *only* place that knows how to take a value apart and put it together, so
// the components stay thin and the round-trip is testable without a DOM.
//
//   valueShape(property, value)          -> 'colour' | 'time' | 'angle' | 'enum'
//                                           | 'functions' | 'fanout' | 'image'
//                                           | 'text' | 'rail'
//   sidesFor(property)                   -> [{ key, label, longhand }] | null
//   splitSides(property, value)          -> { top, right, bottom, left, unit, ok }
//   joinSides(property, sides)           -> the shortest valid form
//   functionList(value)                  -> { name, args: [...] }[] | null
//   joinFunctions(list)                  -> a CSS string
//   enumValues(property, index)          -> ranked keywords, page-used first
//   parseColourParts(value)              -> { h, s, l, a, format, raw } | null
//   joinColourParts(parts, format)       -> a CSS colour string
//   timeOptions(value)                   -> the ms/s pair
//   angleOptions(value)                  -> the deg/turn/rad triple
//
// Everything is pure. Nothing here writes to the page: a view rewrites the
// sheet's value field and Apply commits, which is what keeps every kind's edit
// one property and one undo entry.
import { classify, keywordsFor, formatNumber } from './valueKinds.js';
import { contrast, hslToRgb, rgbToHsl } from './contrast.js';

export { hslToRgb, rgbToHsl };
// SHAPES — the properties whose value is a fan-out of four sides. The value is
// one declaration (`padding`) that reads as four numbers, so the view is one
// sub-rail per side and a "link all sides" toggle.
export const FANOUT = {
padding: ['top', 'right', 'bottom', 'left'],
margin: ['top', 'right', 'bottom', 'left'],
inset: ['top', 'right', 'bottom', 'left'],
'border-width': ['top', 'right', 'bottom', 'left'],
'border-radius': ['top-left', 'top-right', 'bottom-right', 'bottom-left'],
gap: ['row', 'column'],
'background-position': ['x', 'y']
};
// SIDE_LABEL — what each side is called in the view. The corners of a radius are
// arrows in the mock, because `↖ 8px` reads faster than `top-left 8px` on a
// 44 px-wide label column.
export const SIDE_LABEL = {
top: 'top',
right: 'right',
bottom: 'bottom',
left: 'left',
row: 'row',
column: 'column',
x: 'x',
y: 'y',
'top-left': '↖',
'top-right': '↗',
'bottom-right': '↘',
'bottom-left': '↙'
};
// LONGHAND — the four-value shorthand's longhand per property, so a fan-out edit
// can be written out (R2) and collapsed back (R3, shorthandFor).
const LONGHAND = {
padding: (s) => 'padding-' + s,
margin: (s) => 'margin-' + s,
inset: (s) => s === 'top' ? 'top' : s === 'right' ? 'right' : s === 'bottom' ? 'bottom' : 'left',
'border-width': (s) => 'border-' + s + '-width',
'border-radius': (s) => 'border-' + s + '-radius',
gap: (s) => (s === 'row' ? 'row-gap' : 'column-gap'),
'background-position': (s) => 'background-position-' + s
};
// FUNCTION_SHAPE — the properties whose value is an ordered list of functions.
export const FUNCTION_PROPERTIES = new Set(['transform', 'filter', 'backdrop-filter', 'box-shadow', 'text-shadow', 'transition', 'animation']);
// IMAGE_PROPERTIES — properties whose value is a URL or a gradient. The mock's
// K4 note: "no rail — the page's own images and gradients are offered instead".
//
// `content` is deliberately *not* here even though it accepts a `url()`: it is
// a string property first (`content: "→"`, `counter(x)`, `attr(data-label)`), and
// routing it to the image view meant a text value got a view with no candidates
// in it — the mock lists `content` under STRING for exactly that reason.
export const IMAGE_PROPERTIES = new Set(['background-image', 'mask-image', 'list-style-image', 'border-image-source']);
// valueShape — which view a declaration gets. This is the fallback ladder the
// mock states, in order: a numeric kind gets the rail (handled by the caller),
// a numeric shorthand fans out, a known keyword set gets segments, a list of
// functions gets one rail per argument, and anything else falls back to the
// typed field.
export function valueShape(property, value, sticky) {
const prop = String(property || '').trim().toLowerCase();
const raw = String(value == null ? '' : value).trim();
const info = classify(prop, value);
// A custom property is typed by what it holds, so its shape is its literal's.
if (prop.startsWith('--')) {
if (info.number != null) return 'rail';
if (info.kind === 'color') return 'colour';
return 'text';
}
// A value we cannot take apart is never taken apart: `calc(100% - 2px)` splits
// on whitespace into three "sides" that mean nothing, and the mock's ladder ends
// at "the value cannot be parsed: typed field only, raw value preserved".
if (info.kind === 'expression' || info.kind === 'custom') return 'text';
if (info.kind === 'color') return 'colour';
if (info.kind === 'time') return 'time';
if (info.kind === 'angle') return 'angle';
if (IMAGE_PROPERTIES.has(prop)) return 'image';
// A list of functions gets one rail per argument. A property that is a list of
// *shorthands* (box-shadow, transition) is the same view with its items split on
// the top-level commas instead of on function names; a single nameless shadow
// parses as neither and falls back to the typed field, which is the honest
// answer for `0 1px 2px rgba(0,0,0,.4)`.
if (FUNCTION_PROPERTIES.has(prop) && info.kind !== 'keyword' && info.number == null) {
if (functionList(raw)) return 'functions';
const items = listItems(prop, raw);
if (items && items.some((it) => it.args.length > 1)) return 'functions';
}
// A shorthand fans out only when it is *several* values: `padding: 14px` is one
// number that happens to apply four times, so the ladder's first rung (a plain
// rail) is the right view for it, and the fan-out is for
// `10px 14px 18px 14px`.
//
// `sticky` is the view the sheet opened with. A fan-out that collapses to one
// value *while it is open* (drag one side with "link all" on) must not make the
// view vanish under the finger: the sheet is still the same edit, so it keeps
// the view it started with until the property changes.
if (FANOUT[prop]) {
if (raw.split(/\s+/).filter(Boolean).length > 1) {
const split = splitSides(prop, raw);
if (split.ok) return 'fanout';
}
if (sticky === 'fanout') return 'fanout';
}
if (info.number != null) return 'rail';
// An enum needs a real choice set. `keywordsFor` always appends the four
// CSS-wide keywords, so "more than one keyword" would make every keyword an enum
// and give `transform: none` a five-chip row of which four are `inherit` and
// friends. Two *own* keywords is the point at which segments beat a typed field.
if (info.kind === 'keyword' && ownKeywords(prop).length >= 2) return 'enum';
if (info.kind === 'keyword') return 'text';
return 'text';
}
// COMMA_LISTS — properties whose value is a comma-separated list of shorthand
// items rather than of function calls.
export const COMMA_LISTS = new Set(['box-shadow', 'text-shadow', 'transition', 'animation']);
// ownKeywords — a property's keyword set without the CSS-wide tail.
export function ownKeywords(property) {
const WIDE = ['inherit', 'initial', 'unset', 'revert'];
return keywordsFor(property).filter((k) => !WIDE.includes(k));
}
// listItems — the items of a comma-list property as editable rows, so the view
// can render one row per shadow or transition. Each item keeps its position, so
// reordering is a data change and not a string rewrite.
export function listItems(property, value) {
const prop = String(property || '').trim().toLowerCase();
if (!COMMA_LISTS.has(prop)) return null;
const items = splitArgs(String(value == null ? '' : value)).map((s) => s.trim()).filter(Boolean);
if (!items.length) return null;
return items.map((raw, index) => {
// Each item is itself a rail-shaped set of values, so its arguments are split
// the way the function view splits a function's.
const args = splitLooseArgs(raw);
return { index, raw, args };
});
}
// splitLooseArgs — an item's arguments. A comma-list item is space-separated
// (`0px 1px 2px rgba(0, 0, 0, 0.4)`), so this splits on whitespace at bracket
// depth zero: `rgba(0, 0, 0, 0.4)` stays one argument.
export function splitLooseArgs(raw) {
const s = String(raw == null ? '' : raw).trim();
const out = [];
let depth = 0;
let start = 0;
for (let i = 0; i < s.length; i++) {
const c = s[i];
if (c === '(') depth++;
else if (c === ')') depth--;
else if (/\s/.test(c) && depth === 0) {
if (i > start) out.push(s.slice(start, i));
start = i + 1;
}
}
if (start < s.length) out.push(s.slice(start));
return out.map((v) => ({ raw: v, value: v }));
}
// joinListItems — the items back as one declaration.
export function joinListItems(items) {
return (items || []).map((it) => (it.args || []).map((a) => String(a.value == null ? a.raw : a.value)).join(' ')).join(', ');
}
// sidesFor — the four (or two) sides of a shorthand, with their labels and the
// longhand each one writes. `null` for a property that is not a fan-out.
export function sidesFor(property) {
const prop = String(property || '').trim().toLowerCase();
const sides = FANOUT[prop];
if (!sides) return null;
const longhand = LONGHAND[prop];
return sides.map((s) => ({
key: s,
label: SIDE_LABEL[s] || s,
longhand: longhand ? longhand(s) : prop + '-' + s
}));
}
// splitSides — a shorthand value as its parts, in CSS's own expansion order.
//
// `padding: 10px 14px 18px 14px` is top/right/bottom/left; a three-value form
// repeats the second for the left; a two-value form repeats the pair; a
// one-value form repeats the quartet. That is the CSS rule, not a guess, and it
// is why the view can show four rails for any shorthand the page declares.
//
// The unit comes from the first part that has one, so a `10px 14px` shorthand
// reports `px` and a `50% 50%` reports `%`.
export function splitSides(property, value) {
const sides = sidesFor(property);
if (!sides) return { ok: false, reason: 'not a shorthand property' };
const parts = String(value == null ? '' : value).trim().split(/\s+/).filter(Boolean);
if (!parts.length) return { ok: false, reason: 'no value to split' };
// A keyword shorthand (`padding: inherit`) has no sides to drag.
if (parts.every((p) => !/^[-+]?[\d.]/.test(p))) {
return { ok: false, reason: 'a keyword has no sides' };
}
// `gap` and `background-position` take one or two values, not four.
const n = sides.length === 4 ? 4 : 2;
let expanded;
if (n === 4) {
if (parts.length === 1) expanded = [parts[0], parts[0], parts[0], parts[0]];
else if (parts.length === 2) expanded = [parts[0], parts[1], parts[0], parts[1]];
else if (parts.length === 3) expanded = [parts[0], parts[1], parts[2], parts[1]];
else expanded = parts.slice(0, 4);
} else {
if (parts.length === 1) expanded = [parts[0], parts[0]];
else expanded = parts.slice(0, 2);
}
const out = {};
const numbers = {};
let unit = '';
sides.forEach((s, i) => {
const raw = expanded[i] == null ? expanded[0] : expanded[i];
out[s.key] = raw;
const info = classify(property, raw);
if (info && info.number != null) numbers[s.key] = info.number;
if (!unit && info && info.unit) unit = info.unit;
});
return {
ok: true,
unit,
sides: out,
numbers,
// Whether all four are the same value: the "link all sides" toggle starts on
// for a shorthand that is already uniform, because that is the state the user
// is in — and starting it off for `10px` would make the first drag surprising.
uniform: Object.values(out).every((v) => v === Object.values(out)[0]),
values: sides.map((s) => out[s.key]),
reason: ''
};
}
// joinSides — the sides back as the shortest valid shorthand.
//
// This is the *display* write-back for the fan-out view: four equal values
// collapse to one, two values repeat, and three stay three. The full
// `shorthandFor` with the round-trip guarantees lands in R3; this is the same
// rule, kept here so a drag renders correctly before that commit exists.
export function joinSides(property, sides) {
const def = sidesFor(property);
if (!def || !sides) return '';
const v = def.map((s) => String(sides[s.key] == null ? '' : sides[s.key]).trim());
if (v.some((x) => !x)) return '';
if (def.length === 2) {
return v[0] === v[1] ? v[0] : v[0] + ' ' + v[1];
}
if (v[1] === v[3] && v[0] === v[2]) {
return v[0] === v[1] ? v[0] : v[0] + ' ' + v[1];
}
if (v[1] === v[3]) return v[0] + ' ' + v[1] + ' ' + v[2];
return v.join(' ');
}
// functionList — a function-valued declaration as an ordered list.
//
// `transform: translateY(-4px) scale(1.02)` is two functions; each argument is
// its own value with its own kind, which is what lets each one get its own rail
// (K4's "one rail per argument"). The split is bracket-depth aware, because
// `calc(100% - 2px)` and `rgb(1, 2, 3)` contain characters the naive split
// would treat as separators.
//
// Returns `null` when the value is not a function list, which the caller shows
// as the typed field with a note rather than an empty view.
export function functionList(value) {
const raw = String(value == null ? '' : value).trim();
if (!raw) return null;
if (/^(none|inherit|initial|unset|revert)$/i.test(raw)) return null;
const out = [];
let i = 0;
while (i < raw.length) {
// Skip separators between functions.
while (i < raw.length && /[\s,]/.test(raw[i])) i++;
if (i >= raw.length) break;
const nameMatch = /^[-a-z]+\(/i.exec(raw.slice(i));
if (!nameMatch) return null;
const name = nameMatch[0].slice(0, -1);
const open = i + nameMatch[0].length - 1;
const close = matchingParen(raw, open);
if (close < 0) return null;
const inner = raw.slice(open + 1, close);
out.push({
name,
args: splitArgs(inner).map((arg) => ({ raw: arg.trim(), value: arg.trim() })),
index: out.length
});
i = close + 1;
}
return out.length ? out : null;
}
// matchingParen — the index of the `)` matching the `(` at `open`, or -1.
function matchingParen(s, open) {
let depth = 0;
for (let i = open; i < s.length; i++) {
if (s[i] === '(') depth++;
else if (s[i] === ')') {
depth--;
if (depth === 0) return i;
}
}
return -1;
}
// splitArgs — comma-separated arguments that respect nested parens.
export function splitArgs(inner) {
const out = [];
let depth = 0;
let start = 0;
for (let i = 0; i < inner.length; i++) {
const c = inner[i];
if (c === '(') depth++;
else if (c === ')') depth--;
else if (c === ',' && depth === 0) {
out.push(inner.slice(start, i));
start = i + 1;
}
}
out.push(inner.slice(start));
return out.filter((s) => s.trim() !== '');
}
// joinFunctions — the list back as one declaration. `none` is kept as a chip in
// the view (see the mock) and joined as itself.
export function joinFunctions(list) {
if (!Array.isArray(list) || !list.length) return 'none';
return list.map((f) => String(f.name || '') + '(' + (f.args || []).map((a) => String(a.value == null ? a.raw : a.value)).join(', ') + ')').join(' ');
}
// FUNCTION_CATALOG — the functions worth *adding*, with one sensible default
// argument each.
//
// The mock's functions row ends `add / remove / reorder; none as a chip`, and an
// add button that produces `translateX()` is a broken declaration: the only way
// an add can be useful on a phone is if the function arrives already valid and
// already near what a person wants. The defaults are therefore real values from
// the same vocabulary the rest of the panel uses (`-4px` is a lift, `1.05` is a
// hover growth, `45deg` is a rotation), and the catalogue is deliberately short:
// a property with twenty addable functions is a menu, not a control.
export const FUNCTION_CATALOG = {
  transform: [
    { name: 'translateX', args: ['0px'] },
    { name: 'translateY', args: ['-4px'] },
    { name: 'scale', args: ['1.05'] },
    { name: 'rotate', args: ['45deg'] },
    { name: 'skewX', args: ['0deg'] },
    { name: 'skewY', args: ['0deg'] }
  ],
  filter: [
    { name: 'blur', args: ['4px'] },
    { name: 'brightness', args: ['1.1'] },
    { name: 'contrast', args: ['1.1'] },
    { name: 'saturate', args: ['1.2'] },
    { name: 'grayscale', args: ['0.5'] },
    { name: 'hue-rotate', args: ['45deg'] },
    { name: 'opacity', args: ['0.5'] }
  ]
};
// MAX_ADD_CHIPS — how many add buttons a row shows before it stops being a
// control and starts being a list.
export const MAX_ADD_CHIPS = 6;
// addableFunctions — the catalogue entries for a property that this list does
// not already contain. A function already in the value is not offered again:
// `transform: translateY(-4px)` does not need a second translateY chip, and the
// one it has can be edited in place.
export function addableFunctions(property, list) {
const prop = String(property || '').trim().toLowerCase();
const spec = FUNCTION_CATALOG[prop];
if (!spec) return [];
const used = new Set((list || []).map((f) => String(f && f.name || '').toLowerCase()));
return spec.filter((s) => !used.has(s.name.toLowerCase())).slice(0, MAX_ADD_CHIPS);
}
// addFunction — the list with one catalogue entry appended, in the same shape
// `functionList` produces (`{ name, args: [{ raw, value }], index }`), so the
// result can be written with `joinFunctions` and read straight back.
export function addFunction(list, spec) {
const base = Array.isArray(list) ? list : [];
if (!spec || !spec.name) return base;
const next = base.concat([{
name: String(spec.name),
args: (spec.args || []).map((a) => ({ raw: String(a), value: String(a) })),
index: base.length
}]);
return next.map((f, i) => Object.assign({}, f, { index: i }));
}
// moveFunction — the list with one entry swapped with its neighbour. `dir` is
// -1 for earlier and +1 for later; a move off either end returns the list
// unchanged, so the caller can render both buttons without checking first.
//
// Order matters for a transform list (the operations are not commutative) and
// for a filter list (a blur before a contrast is not the same as after), which
// is why reordering is a real feature and not just a tidy-up.
export function moveFunction(list, index, dir) {
if (!Array.isArray(list)) return [];
const from = Number(index);
const to = from + (dir < 0 ? -1 : 1);
if (!Number.isFinite(from) || from < 0 || from >= list.length) return list;
if (to < 0 || to >= list.length) return list;
const next = list.slice();
const tmp = next[from];
next[from] = next[to];
next[to] = tmp;
return next.map((f, i) => Object.assign({}, f, { index: i }));
}
// functionsToNone — the value a function list writes when it is emptied. `none`
// is what the mock's chip writes, and it is a real declaration for the
// properties that take it (`transform: none`), which is why it is a chip rather
// than a delete-to-empty text field.
export const FUNCTIONS_NONE = 'none';
// enumValues — the keyword chips for a property, ranked: the values the page
// actually uses first (in the order the index reports them), then the property's
// own spec set, then the CSS-wide keywords last.
//
// The ranking is the whole point of the view: a `display` row that offers
// `flex grid block inline none list` in the spec's order makes the user read
// all six, while the page's own order answers "what does this site use?" first.
export function enumValues(property, used) {
const prop = String(property || '').trim().toLowerCase();
const spec = keywordsFor(prop);
const CSS_WIDE = ['inherit', 'initial', 'unset', 'revert'];
const out = [];
const push = (k, source) => {
const key = String(k || '').trim().toLowerCase();
if (!key || out.some((e) => e.key === key)) return;
out.push({ key, value: String(k).trim(), source, wide: CSS_WIDE.includes(key) });
};
for (const u of used || []) {
const v = (u && u.value) ? u.value : u;
push(v, 'page');
}
for (const k of spec) push(k, 'spec');
// A value in force that is in neither list is still offered, because the row has
// to be able to show where the element is.
return out;
}
// parseColourParts — a colour as H/S/L plus its alpha and its original format.
//
// The rails work in H/S/L (the mock's three rails), and the format chips decide
// how the value is written back. `rgb()`-and-`hex` values are converted through
// their actual channels rather than kept as text, so a `#1c2333` can be dragged
// on the hue rail at all.
export function parseColourParts(value) {
const raw = String(value == null ? '' : value).trim();
if (!raw) return null;
const lower = raw.toLowerCase();
let rgb = null;
let alpha = 1;
// An `hsl()` value is *kept* as its own H/S/L rather than round-tripped through
// RGB: `hsl(220, 38%, 15%)` becomes `rgb(24, 33, 53)`, whose own hue is 221.7,
// so a rail built from the pixels would read 222° for a value the user typed as
// 220° — and dragging it one step would write a colour they did not ask for.
let hslDirect = null;
if (lower === 'transparent') { rgb = { r: 0, g: 0, b: 0 }; alpha = 0; }
else if (lower === 'currentcolor') return { keyword: 'currentcolor', format: 'keyword', raw };
else if (lower in NAMED_SIMPLE) rgb = NAMED_SIMPLE[lower];
else {
const hex = /^#([0-9a-f]{3,8})$/i.exec(lower);
if (hex) {
const h = hex[1];
const ex = (s) => parseInt(s.length === 1 ? s + s : s, 16);
if (h.length === 3 || h.length === 4) {
rgb = { r: ex(h[0]), g: ex(h[1]), b: ex(h[2]) };
if (h.length === 4) alpha = ex(h[3]) / 255;
} else if (h.length === 6 || h.length === 8) {
rgb = { r: ex(h.slice(0, 2)), g: ex(h.slice(2, 4)), b: ex(h.slice(4, 6)) };
if (h.length === 8) alpha = ex(h.slice(6, 8)) / 255;
}
} else {
const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(lower);
if (fn) {
const parts = fn[2].replace(/\//g, ' ').replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
if (fn[1].startsWith('hsl')) {
const h = parseFloat(parts[0]);
const s = parseFloat(parts[1]) / (/%$/.test(parts[1]) ? 100 : 1);
const l = parseFloat(parts[2]) / (/%$/.test(parts[2]) ? 100 : 1);
if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;
hslDirect = { h: ((h % 360) + 360) % 360, s: Math.max(0, Math.min(1, s)), l: Math.max(0, Math.min(1, l)) };
rgb = hslToRgb(hslDirect.h, hslDirect.s, hslDirect.l);
} else {
const r = parseFloat(parts[0]);
const g = parseFloat(parts[1]);
const b = parseFloat(parts[2]);
if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
rgb = { r, g, b };
}
if (parts[3] != null) {
const a = parseFloat(parts[3]);
alpha = /%$/.test(parts[3]) ? a / 100 : a;
}
}
}
}
if (!rgb) return { keyword: null, format: 'unknown', raw };
const hsl = hslDirect || rgbToHsl(rgb);
return {
h: hsl.h,
s: hsl.s,
l: hsl.l,
a: Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1,
rgb: { r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b) },
format: /^#/.test(lower) ? 'hex' : /^hsl/.test(lower) ? 'hsl' : /^rgb/.test(lower) ? 'rgb' : 'named',
raw,
keyword: null
};
}
// A small named-colour table: enough for the values that appear in real
// stylesheets, and the same subset contrast.js uses. An unknown name returns
// `format: 'unknown'` and the view falls back to the typed field.
const NAMED_SIMPLE = {
black: { r: 0, g: 0, b: 0 }, white: { r: 255, g: 255, b: 255 }, red: { r: 255, g: 0, b: 0 },
green: { r: 0, g: 128, b: 0 }, blue: { r: 0, g: 0, b: 255 }, grey: { r: 128, g: 128, b: 128 },
gray: { r: 128, g: 128, b: 128 }, silver: { r: 192, g: 192, b: 192 }, yellow: { r: 255, g: 255, b: 0 },
orange: { r: 255, g: 165, b: 0 }, purple: { r: 128, g: 0, b: 128 }, pink: { r: 255, g: 192, b: 203 },
navy: { r: 0, g: 0, b: 128 }, teal: { r: 0, g: 128, b: 128 }, lime: { r: 0, g: 255, b: 0 },
cyan: { r: 0, g: 255, b: 255 }, aqua: { r: 0, g: 255, b: 255 }, magenta: { r: 255, g: 0, b: 255 },
fuchsia: { r: 255, g: 0, b: 255 }, maroon: { r: 128, g: 0, b: 0 }, olive: { r: 128, g: 128, b: 0 },
rebeccapurple: { r: 102, g: 51, b: 153 }
};
// joinColourParts — H/S/L back as a CSS colour in the requested format.
//
// Hex is the default (it is what a design system stores), `rgb()` is the
// readable one, and `hsl()` keeps the numbers the user was just dragging — which
// matters because converting to hex and back loses the round trip on a
// fractional hue.
export function joinColourParts(parts, format) {
const p = parts || {};
if (p.keyword === 'currentcolor') return 'currentcolor';
const alpha = p.a == null ? 1 : p.a;
const rgb = p.rgb || hslToRgb(p.h || 0, p.s || 0, p.l || 0);
const fmt = format || p.format || 'hex';
const two = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
if (fmt === 'rgb') {
return alpha < 1
? 'rgba(' + Math.round(rgb.r) + ', ' + Math.round(rgb.g) + ', ' + Math.round(rgb.b) + ', ' + formatNumber(alpha) + ')'
: 'rgb(' + Math.round(rgb.r) + ', ' + Math.round(rgb.g) + ', ' + Math.round(rgb.b) + ')';
}
if (fmt === 'hsl') {
const h = formatNumber(Math.round(p.h || 0));
const s = formatNumber(Math.round((p.s || 0) * 100));
const l = formatNumber(Math.round((p.l || 0) * 100));
return alpha < 1
? 'hsla(' + h + ', ' + s + '%, ' + l + '%, ' + formatNumber(alpha) + ')'
: 'hsl(' + h + ', ' + s + '%, ' + l + '%)';
}
const hex = '#' + two(rgb.r) + two(rgb.g) + two(rgb.b);
return alpha < 1 ? hex + two(alpha * 255) : hex;
}
// colourRailValues — the read positions and end colours of the three rails, in
// one call, so the view's render is a map rather than three branches.
//
// Each rail's track is a live gradient: the hue rail is the full gamut at the
// current saturation and lightness, the saturation rail runs from grey to the
// fully saturated hue, and the lightness rail from black through the colour to
// white. That is what makes a rail a *view* of the colour rather than a number
// beside it.
export function colourRailValues(parts) {
const p = parts || {};
const h = Number.isFinite(p.h) ? p.h : 0;
const s = Number.isFinite(p.s) ? p.s : 0;
const l = Number.isFinite(p.l) ? p.l : 0;
const at = (hh, ss, ll) => joinColourParts({ h: hh, s: ss, l: ll, a: 1 }, 'hex');
// The hue track: the seven stops the mock draws.
const hueTrack = [0, 60, 120, 180, 240, 300, 360].map((d) => at(d, Math.max(s, 0.5), 0.5));
return [
{ key: 'h', label: 'hue', value: Math.round(h), min: 0, max: 360, suffix: '°',
track: 'linear-gradient(90deg, ' + hueTrack.join(', ') + ')',
end: 'rainbow = full gamut', now: at(h, s, l) },
{ key: 's', label: 'saturation', value: Math.round(s * 100), min: 0, max: 100, suffix: '%',
track: 'linear-gradient(90deg, ' + at(h, 0, l) + ', ' + at(h, 1, l) + ')',
end: '0 = grey', now: at(h, s, l) },
{ key: 'l', label: 'lightness', value: Math.round(l * 100), min: 0, max: 100, suffix: '%',
track: 'linear-gradient(90deg, ' + at(h, s, 0) + ', ' + at(h, s, 0.5) + ', ' + at(h, s, 1) + ')',
end: '50% = true colour', now: at(h, s, l) }
];
}
// applyRailPart — a colour rail's new value folded back into the parts. One
// function per rail key, so the view never has to remember which of h/s/l is a
// 0…1 float and which is a 0…360 degree.
export function applyRailPart(parts, key, value) {
const p = Object.assign({}, parts);
const n = Number(value);
if (!Number.isFinite(n)) return p;
if (key === 'h') p.h = n;
else if (key === 's') p.s = Math.max(0, Math.min(1, n / 100));
else if (key === 'l') p.l = Math.max(0, Math.min(1, n / 100));
// The rgb snapshot is recomputed because the format chips write from it, and a
// stale one would make a `rgb()` chip write the pre-drag colour.
p.rgb = hslToRgb(p.h || 0, p.s || 0, p.l || 0);
return p;
}
// timeOptions — the ms/s pair for a time value, with the conversion applied.
export function timeOptions(value) {
const info = classify('transition-duration', value);
if (!info || info.number == null) return [];
const ms = info.unit === 's' ? info.number * 1000 : info.number;
return [
{ unit: 'ms', current: info.unit === 'ms', value: formatNumber(ms) + 'ms' },
{ unit: 's', current: info.unit === 's', value: formatNumber(ms / 1000) + 's' }
];
}
// angleOptions — the deg/turn/rad triple. Same shape as the time pair, because
// the view renders them with the same segmented control.
export function angleOptions(value) {
const info = classify('rotate', value);
if (!info || info.number == null) return [];
const deg = info.unit === 'turn' ? info.number * 360
: info.unit === 'rad' ? info.number * (180 / Math.PI)
: info.number;
return [
{ unit: 'deg', current: info.unit === 'deg', value: formatNumber(deg) + 'deg' },
{ unit: 'turn', current: info.unit === 'turn', value: formatNumber(deg / 360) + 'turn' },
{ unit: 'rad', current: info.unit === 'rad', value: formatNumber(deg * (Math.PI / 180)) + 'rad' }
];
}
// angleSnaps — the angles worth snapping to on the angle rail. Every one of them
// is a right angle or half of one, which is what a rotation is almost always
// for: `0/45/90/180` is the mock's list, and the negative side is included
// because the range runs −180…180.
export const ANGLE_SNAPS = [-180, -90, -45, 0, 45, 90, 180];
// contrastForValue — the WCAG reading a colour candidate gets against the
// element's background, for the palette row. A candidate that cannot be read
// comes back with the reason instead of a ratio.
export function contrastForValue(value, background, ctx) {
return contrast(background, value, ctx);
}
// imageCandidates — the page's own images and gradients, offered instead of a
// rail (the mock's K4 note). A `url(...)` value is offered as the relative path
// it is; a gradient is offered whole, because a gradient is not a number.
export function imageCandidates(values) {
const out = [];
for (const v of values || []) {
const value = (v && v.value) ? v.value : v;
const raw = String(value || '').trim();
if (!raw) continue;
if (/^url\(/i.test(raw) || /gradient\(/i.test(raw)) {
if (!out.some((e) => e.value === raw)) out.push({ value: raw, thumb: /^url\(/i.test(raw) });
}
}
return out;
}
