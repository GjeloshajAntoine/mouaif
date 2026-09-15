// Inspector Styles panel — the touch-first control model.
//
// The panel used to offer exactly one way to change a style: tap a property row
// and type a value in the bottom sheet. That is the right *fallback* — it can
// write any property — but it is not the right *default* on a phone. Choosing an
// element and then having to know that `display` takes `flex`, that `gap` is a
// length, and that `justify-content` wants `space-between` is the keyboard tax
// the desktop Styles pane charges and a touch UI should not.
//
// This module is the data behind the touch surface: which controls the panel
// shows for the selected element, what each control's value *is* right now, and
// what tapping or dragging a control writes. It is deliberately pure — no
// Preact, no DOM, no CDP — so every rule here (the range a slider has, which
// segment is on, what `+` does to `1.5rem`, which property cards a search
// leaves) is asserted in scripts/test-inspector-touch-controls.js rather than
// through the UI.
//
// Three decisions worth naming:
//
//   1. **A control reads the element like the panel does.** `readValue` prefers
//      the element's own inline declaration and falls back to the computed
//      value, so a control shows what the element *renders* even when the value
//      comes from a class — and tapping a segment or releasing a slider writes
//      to `element.style`, exactly like a declared row does.
//   2. **Nothing is written until the user commits.** A slider drag previews in
//      local state and writes once on release, so a 200 px drag is one CDP
//      write, one receipt entry and one undo — not sixty.
//   3. **A control that cannot be honest is not shown.** Flex controls appear
//      only when the element is actually a flex container (`when`), a keyword
//      value (`auto`) leaves the slider numberless instead of pretending it is
//      0, and a unit conversion with no base size falls back to px rather than
//      inventing a number.
import { classify, unitOptions, formatNumber } from './valueKinds.js';

// GROUPS — the tabs the surface switches between. Six, in the order the images
// read them, and each one a *mode* of the same element rather than a separate
// screen: the selection never changes under the user's finger, only which of its
// properties are on screen. Six chips wrap to two rows at 360 px, which is why
// the row is a wrapped chip row and not a sideways scroller (see the panel's
// no-horizontal-scroll invariant).
export const GROUPS = [
{ id: 'layout', label: 'Layout' },
{ id: 'spacing', label: 'Spacing' },
{ id: 'size', label: 'Size' },
{ id: 'text', label: 'Text' },
{ id: 'colour', label: 'Colour' },
{ id: 'effects', label: 'Effects' }
];

// SIDES / SIDE_LABEL — the four physical edges the box editor edits, in the
// order a box model is read (clockwise from the top).
export const SIDES = ['top', 'right', 'bottom', 'left'];
export const SIDE_LABEL = { top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left' };
// The box editor's two rings: the outside of the element and its inside.
export const BOXES = [
{ id: 'margin', label: 'Margin', note: 'outside the element' },
{ id: 'padding', label: 'Padding', note: 'inside the element' }
];

// RANGE_SPECS — the numeric span each slider covers, per property.
//
// The spans are chosen for a phone, not for CSS: `gap` runs 0…64 because a
// layout gap above 64 px is a different design, `font-size` runs 8…72 because
// that is the range a page's own type scale lives in, and `opacity` runs 0…1
// because a 0…100 % slider spends 90 % of its travel in values nobody types.
// `step` is the coarse step (the −/+ pair and the Fine/Coarse switch in the row
// footer scale off it — see stepChoices). `units` is the write vocabulary: the
// *unit* chips come from valueKinds' unitOptions, so a conversion without a base
// size is absent or disabled rather than guessed.
export const RANGE_SPECS = {
gap: { min: 0, max: 64, step: 4, units: ['px', 'rem'] },
'row-gap': { min: 0, max: 64, step: 4, units: ['px', 'rem'] },
'column-gap': { min: 0, max: 64, step: 4, units: ['px', 'rem'] },
padding: { min: 0, max: 64, step: 4, units: ['px', 'rem', '%'] },
margin: { min: 0, max: 64, step: 4, units: ['px', 'rem', '%'] },
width: { min: 0, max: 600, step: 8, units: ['px', '%', 'rem'] },
height: { min: 0, max: 600, step: 8, units: ['px', '%', 'rem'] },
'border-radius': { min: 0, max: 96, step: 4, units: ['px', '%', 'rem'] },
'border-width': { min: 0, max: 16, step: 1, units: ['px'] },
'font-size': { min: 8, max: 72, step: 2, units: ['px', 'rem', 'em'] },
'line-height': { min: 0.8, max: 3, step: 0.1, units: [] },
'letter-spacing': { min: -2, max: 12, step: 0.5, units: ['px', 'rem'] },
opacity: { min: 0, max: 1, step: 0.1, units: [] }
};

// DEFAULT_SPEC — a property the surface has no span for still gets a usable
// slider when it is reached by name (a side longhand, or `padding-top` from the
// box editor): 0…96 px in 4 px steps is the "spacing-ish" default.
const DEFAULT_SPEC = { min: 0, max: 96, step: 4, units: ['px', 'rem', '%'] };

// SIDE_SUFFIX — `padding-top` -> `padding`, so a side longhand reuses the
// shorthand's span, keyword list and family. Only the four physical sides are
// stripped: `border-top-left-radius` is a different property with its own
// (unknown) span and falls through to DEFAULT_SPEC.
const SIDE_SUFFIX = /-(top|right|bottom|left)$/;

// baseProp — the property a longhand is a side of (or the property itself).
export function baseProp(prop) {
const p = String(prop || '').trim().toLowerCase();
return SIDE_SUFFIX.test(p) ? p.replace(SIDE_SUFFIX, '') : p;
}

// specFor — the slider span for a property, side longhands included.
export function specFor(prop) {
const p = String(prop || '').trim().toLowerCase();
return RANGE_SPECS[p] || RANGE_SPECS[baseProp(p)] || DEFAULT_SPEC;
}

// SPEC_ALT — the second form a value can take. `line-height` is the one property
// whose *authored* form (a multiplier: `1.5`) and *resolved* form (px: `62px`)
// disagree about what the number means, and the computed style — which is what
// this panel reads for a value no rule declares here — always reports px. A 0.8…3
// slider handed `62px` is pinned at its maximum and cannot move, which is the
// exact failure a control surface must not have: the row would look alive and do
// nothing. So the px form gets a px span.
const SPEC_ALT = {
'line-height': { min: 8, max: 96, step: 1, units: ['px'] }
};

// specForValue — the span for *this* value. The base spec unless the property has
// an alternate form and the value is in it.
export function specForValue(prop, value) {
const base = specFor(prop);
const alt = SPEC_ALT[baseProp(prop)];
if (!alt) return base;
const parsed = parseNumber(value);
const inAltForm = parsed && parsed.unit && (base.units || []).indexOf(parsed.unit) < 0
&& (alt.units || []).indexOf(parsed.unit) >= 0;
return inAltForm ? alt : base;
}

// stepChoices — the Fine / Coarse pair for a row, in the wording the images use.
// Coarse is the spec's own step (the design scale: 4 px, 0.1); Fine is a quarter
// of it for the spans where that is meaningful, and half for the coarse steps
// that are already fine (1 px, 0.1).
export function stepChoices(spec) {
const coarse = (spec && spec.step) || 1;
const fine = coarse >= 4 ? coarse / 4 : coarse / 2;
return { coarse, fine };
}

// readValue — the value the element has for a property: its own declaration
// first (`element.style`, what an edit here writes and what the declared list
// shows), then the computed value (`getComputedStyleForNode`, which resolves a
// value supplied by a class or a browser default). Returns '' when the property
// is in neither list, which every caller reads as "not set here".
export function readValue(prop, ctx) {
const p = String(prop || '').trim().toLowerCase();
if (!p) return '';
const declared = (ctx && ctx.declared) || [];
const computed = (ctx && ctx.computed) || [];
for (const row of declared) {
if (row && String(row.prop || '').toLowerCase() === p) return String(row.value == null ? '' : row.value);
}
for (const row of computed) {
if (row && String(row.prop || '').toLowerCase() === p) return String(row.value == null ? '' : row.value);
}
return '';
}

// SHORTHAND_SIDES — the shorthands the CSSOM actually *stores* as longhands, with
// the side order CSS writes them in. `padding: 12px 8px` is never a row in the
// element's own styles: the engine keeps `padding-top/right/bottom/left`, which is
// what the panel's declared list shows and what the box model edits. So a question
// about the shorthand ("is padding set here?") has to be answered by its longhands,
// and the answer can be folded back into shorthand form (`12px 8px`).
const SHORTHAND_SIDES = {
padding: ['top', 'right', 'bottom', 'left'],
margin: ['top', 'right', 'bottom', 'left'],
'border-width': ['top', 'right', 'bottom', 'left'],
'border-color': ['top', 'right', 'bottom', 'left'],
'border-style': ['top', 'right', 'bottom', 'left'],
inset: ['top', 'right', 'bottom', 'left']
};

// foldSides — four values back into the shortest honest shorthand: `12px` when
// they agree, `12px 8px` when the pairs agree, and the full four otherwise. Only
// used for a *read* (a card that says "already added · 12px 8px"); an edit still
// writes the longhand the user actually touched.
export function foldSides(values) {
const [t, r, b, l] = values;
if (t === r && r === b && b === l) return t;
if (t === b && r === l) return t + ' ' + r;
if (r === l) return t + ' ' + r + ' ' + b;
return values.join(' ');
}

// exactDeclared — the element's own value for a property, or null when it
// declares none. The lower half of readDeclared, kept separate because the
// longhand check needs exactly this (no shorthand fallback).
function exactDeclared(prop, ctx) {
const p = String(prop || '').trim().toLowerCase();
if (!p) return null;
for (const row of ((ctx && ctx.declared) || [])) {
if (row && String(row.prop || '').toLowerCase() === p) return String(row.value == null ? '' : row.value);
}
return null;
}

// readDeclared — the value the element declares for a property, following a
// shorthand down to its longhands. null means "not declared here" (which is not
// the same as "not set": the value may come from a rule — see readValue).
export function readDeclared(prop, ctx) {
const p = String(prop || '').trim().toLowerCase();
const exact = exactDeclared(p, ctx);
if (exact != null) return exact;
const sides = SHORTHAND_SIDES[p];
if (!sides) return null;
const values = sides.map((side) => exactDeclared(p + '-' + side, ctx));
return values.every((v) => v != null) ? foldSides(values) : null;
}

// isDeclared — whether the element's own style sets the property, longhands
// included. Every "set here" badge, tab dot and card state reads this, so a
// `border-radius: 8px` written by the engine as four corner longhands still reads
// as set rather than as "not added yet".
export function isDeclared(prop, ctx) {
return readDeclared(prop, ctx) != null;
}

// VALUE_NUMBER_RE — a bare number with an optional unit, which is what a slider can
// move. `auto`, `calc(...)`, `min-content` and `var(--x)` deliberately fail it:
// a slider whose thumb sits at 0 while the element renders `auto` is a lie, so
// those rows show the value and their keyword chips instead.
const VALUE_NUMBER_RE = /^([-+]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i;

// parseNumber — `24px` -> { number: 24, unit: 'px' }; `auto` -> null.
export function parseNumber(value) {
const m = VALUE_NUMBER_RE.exec(String(value == null ? '' : value).trim());
if (!m) return null;
const number = Number(m[1]);
if (!Number.isFinite(number)) return null;
return { number, unit: (m[2] || '').toLowerCase() };
}

// pxOf — a value in px, for the slider's own arithmetic. `rem` and `em` need the
// real base sizes (the panel reads them with the element's styles — see
// events.js readElementStyles); without them the number is used as-is, which
// keeps the slider usable instead of dead on a page the panel could not size.
export function pxOf(value, ctx) {
// A raw px number is accepted too: the slider's own arithmetic already holds
// one, and re-parsing it through the value string would be a needless dance.
if (typeof value === 'number' && Number.isFinite(value)) return value;
const parsed = parseNumber(value);
if (!parsed) return null;
const c = ctx || {};
if (parsed.unit === 'rem') return c.rootFontSize ? parsed.number * c.rootFontSize : parsed.number;
if (parsed.unit === 'em') return (c.parentFontSize || c.fontSize) ? parsed.number * (c.parentFontSize || c.fontSize) : parsed.number;
return parsed.number;
}

// toUnit — write a px number back in a unit. `rem`/`em` are exact when their
// base is known and fall back to px when it is not; `%` is only derivable for
// the two properties whose percentage base the panel actually reads (font-size
// and line-height resolve against the parent's font size), so everything else
// stays px rather than inventing a percentage of a container nobody measured.
export function toUnit(px, prop, unit, ctx) {
const c = ctx || {};
// `''` is the unitless form (`opacity`, `line-height`) and has to survive:
// defaulting it to px here would write `0.5px` for an opacity.
const u = (unit == null ? 'px' : String(unit)).toLowerCase();
const n = Number(px);
if (!Number.isFinite(n)) return '';
if (u === '' || u === 'number') return formatNumber(n);
if (u === 'px') return formatNumber(n) + 'px';
if (u === 'rem' && c.rootFontSize) return formatNumber(n / c.rootFontSize) + 'rem';
if (u === 'em' && (c.parentFontSize || c.fontSize)) return formatNumber(n / (c.parentFontSize || c.fontSize)) + 'em';
if (u === '%') {
const p = String(prop || '').toLowerCase();
if (p === 'font-size' || p === 'line-height') {
const base = c.parentFontSize || c.fontSize;
if (base) return formatNumber((n / base) * 100) + '%';
}
}
return formatNumber(n) + 'px';
}

// unitFor — the unit a row writes in: the unit the value already uses when it
// has one (so dragging a `1.5rem` radius keeps it in rem instead of silently
// rewriting the declaration as px), a unitless property stays unitless, and
// anything unparsable starts at px.
export function unitFor(prop, value, spec) {
const parsed = parseNumber(value);
if (parsed) {
if (!parsed.unit && (spec.units || []).length === 0) return '';
return parsed.unit || 'px';
}
return (spec.units || ['px'])[0];
}

// percentFor — where a value sits on its slider, 0…1. A value that does not
// parse, or that lies outside the span, is pinned to the nearest end (a `120px`
// gap reads as "at the maximum" rather than as a broken control).
export function percentFor(value, spec) {
const px = pxOf(value);
const s = spec || DEFAULT_SPEC;
if (px == null) return 0;
const span = s.max - s.min;
if (!(span > 0)) return 0;
return Math.min(1, Math.max(0, (px - s.min) / span));
}

// quantize — land on the step grid. Without it a drag produces `23.0000001px`
// in the receipt and in `element.style`; with it the value is the one the step
// names (`1.2`, not `1.2000000000000002`, which is what `12 * 0.1` is in binary
// floating point and what the panel would then print).
export function quantize(n, step) {
const s = Number(step);
if (!(s > 0)) return n;
const stepped = Math.round(n / s) * s;
// The step's own decimals, when it is a plain decimal (`0.1` -> 1, `0.05` -> 2).
// An exponent-form step falls back to a fixed 6-decimal round.
const text = String(s);
if (text.indexOf('e') >= 0) return Math.round(stepped * 1e6) / 1e6;
const decimals = (text.split('.')[1] || '').length;
return Number(stepped.toFixed(decimals));
}

// valueAtPercent — the value a slider position stands for, in px. Quantized to
// the step in force (Fine/Coarse) and clamped to the spec.
export function valueAtPercent(pct, spec, step) {
const s = spec || DEFAULT_SPEC;
const clamped = Math.min(1, Math.max(0, Number(pct) || 0));
const raw = s.min + clamped * (s.max - s.min);
const n = quantize(raw, step || s.step);
return Math.min(s.max, Math.max(s.min, n));
}

// nudgeValue — what a − or + tap writes. Deliberately returns null for a value
// the slider cannot move (a keyword): the steppers are disabled and say why,
// rather than replacing `auto` with `4px` behind the user's back.
export function nudgeValue(value, dir, spec, step) {
const s = spec || DEFAULT_SPEC;
const parsed = parseNumber(value);
// A keyword (`auto`, `min-content`, `var(--x)`) has no number to walk, so the
// steppers are disabled: replacing `auto` with `4px` is not a nudge, it is a
// different declaration.
if (!parsed) return null;
const base = pxOf(value);
if (base == null) return null;
const next = quantize(base + (Number(dir) < 0 ? -1 : 1) * (step || s.step), step || s.step);
const clamped = Math.min(s.max, Math.max(s.min, next));
const unit = parsed.unit || (s.units || ['px'])[0];
return { px: clamped, css: toUnit(clamped, '', unit) };
}

// unitChoices — the unit chips for a row, from valueKinds' unitOptions so the
// conversions (and the reasons a conversion is unavailable) are the same ones
// the edit sheet's unit row shows. A row with fewer than two choices renders no
// chips at all (a control of one is not a control).
export function unitChoices(prop, value, ctx) {
const parsed = parseNumber(value);
if (!parsed) return [];
const opts = unitOptions(prop, value, ctx || {});
const wanted = specFor(prop).units || [];
const rows = opts.filter((o) => o.unit === '' || wanted.indexOf(o.unit) >= 0 || o.current);
// A unitless property (`opacity`, `line-height`) has no unit to switch to: the
// cycle would offer `px` for a value that must stay a number.
if (!parsed.unit && wanted.length === 0) return [];
return rows.map((o) => ({
unit: o.unit,
value: o.value,
current: !!o.current,
ok: o.ok !== false,
reason: o.reason || '',
title: o.current
? o.unit + ' — the unit in use'
: (o.ok !== false ? 'Rewrite as ' + o.value : 'Not available: ' + (o.reason || ''))
}));
}

// segmentOptions — the segment chips for an enum control, with the current one
// marked. An element whose value the list does not name (`display: table`) gets
// that value as one extra, non-tappable chip rather than an empty segment row:
// the row then answers "what is it now?" instead of leaving every chip dark.
export function segmentOptions(control, value) {
const current = String(value == null ? '' : value).trim().toLowerCase();
const options = (control && control.options) || [];
const rows = options.map((o) => ({
value: o.value,
label: o.label,
glyph: o.glyph || '',
isOn: o.value === current,
title: o.value === current ? o.value + ' — the value in force' : 'Set ' + control.prop + ' to ' + o.value
}));
if (current && !rows.some((r) => r.isOn)) {
rows.unshift({ value: current, label: current, glyph: '·', isOn: true, unknown: true, title: current + ' — set elsewhere, not one of this control\'s options' });
}
return rows;
}

// isFlex / isGrid — whether the element is a flex/grid container *now*, which is
// what gates the container-only controls. `inline-flex` and `inline-grid` count:
// they are the same layout algorithm with an inline-level box.
function display(ctx) {
return readValue('display', ctx).trim().toLowerCase();
}
export function isFlex(ctx) {
const d = display(ctx);
return d === 'flex' || d === 'inline-flex';
}
export function isGrid(ctx) {
const d = display(ctx);
return d === 'grid' || d === 'inline-grid';
}

// GRADIENT_PRESETS — the gradients a phone user can actually get to.
//
// `background-image` is the one property in the surface whose value has no
// keyboard on-ramp: `linear-gradient(135deg, #f00 0%, #00f 100%)` is thirty-odd
// characters of punctuation, and typing it on a phone is the exact tax this
// whole surface exists to remove. So the image control offers a few named
// directions instead — one tap, one write — and `none` to take the image back
// off (which is the other thing a user needs and could otherwise only reach by
// opening the editor and clearing the field).
//
// The stops are the two endpoints only, written in the exact form Chrome
// serialises back: `rgb()` rather than hex, and no `180deg` on a vertical
// gradient (the browser drops a default direction). That is not cosmetic — the
// chip row compares the element's value against these strings to decide which
// preset is in force, and `#ffffff` comes back as `rgb(255, 255, 255)`, so a hex
// preset would never light up and every tap would look like it did nothing.
// Verified against Chrome 140: all six below round-trip byte-identical.
//
// They are starting points, not a palette: the edit sheet's value field is one
// tap away for anything else.
export const GRADIENT_PRESETS = [
{ id: 'none', label: 'None', value: 'none', hint: 'No background image' },
{ id: 'down', label: 'Down', value: 'linear-gradient(rgb(255, 255, 255) 0%, rgb(220, 220, 220) 100%)', hint: 'Fade downward' },
{ id: 'accent', label: 'Accent', value: 'linear-gradient(135deg, rgb(79, 140, 255) 0%, rgb(139, 92, 246) 100%)', hint: 'A two-hue accent wash' },
{ id: 'warm', label: 'Warm', value: 'linear-gradient(135deg, rgb(255, 179, 71) 0%, rgb(255, 94, 98) 100%)', hint: 'Orange to red' },
{ id: 'cool', label: 'Cool', value: 'linear-gradient(135deg, rgb(54, 209, 220) 0%, rgb(91, 134, 229) 100%)', hint: 'Teal to blue' },
{ id: 'fade', label: 'Fade out', value: 'linear-gradient(rgba(0, 0, 0, 0.45) 0%, rgba(0, 0, 0, 0) 100%)', hint: 'A scrim for text over a photo' }
];

// imagePresets — the preset chips for the image control, with the one in force
// marked. `value` matching is normalised (whitespace runs collapsed, lower
// cased) because the browser re-serialises what it stores: a preset typed as
// `linear-gradient(135deg, #4f8cff 0%, #8b5cf6 100%)` comes back from the
// element as the same string, but one written by hand may not.
export function imagePresets(value) {
const current = valueKeyOf(value);
return GRADIENT_PRESETS.map((g) => ({
value: g.value,
label: g.label,
hint: g.hint,
isOn: valueKeyOf(g.value) === current,
title: g.isOn ? g.label + ' — the value in force' : 'Set background-image to ' + g.hint.toLowerCase()
}));
}

// valueKeyOf — a value's identity for comparing a preset against what the
// element holds. Local to this module so the control model stays free of the
// value-index module (they are separate concerns).
function valueKeyOf(value) {
return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
}

// CONTROLS — every control the surface can show, in group order.
//
// `when` is a predicate over the element's *current* styles, not a static
// per-element guess: choosing Flex in the Display row adds the direction,
// alignment and gap rows on the next render, and choosing Block takes them away.
// That is the one place this surface is dynamic, and it is what keeps a Block
// element's Layout tab from offering five controls that do nothing.
export const CONTROLS = [
{ id: 'display', group: 'layout', prop: 'display', label: 'Display', kind: 'segments',
hint: 'How the box takes part in the layout',
options: [
{ value: 'block', label: 'Block', glyph: '▤' },
{ value: 'flex', label: 'Flex', glyph: '⇤' },
{ value: 'grid', label: 'Grid', glyph: '▦' },
{ value: 'inline-flex', label: 'Inline', glyph: '↔' },
{ value: 'none', label: 'None', glyph: '⃠' }
] },
{ id: 'flex-direction', group: 'layout', prop: 'flex-direction', label: 'Direction', kind: 'segments', when: isFlex,
hint: 'Which way the children flow',
options: [
{ value: 'row', label: 'Row', glyph: '→' },
{ value: 'row-reverse', label: 'Row ↺', glyph: '←' },
{ value: 'column', label: 'Column', glyph: '↓' },
{ value: 'column-reverse', label: 'Col ↺', glyph: '↑' }
] },
{ id: 'align-items', group: 'layout', prop: 'align-items', label: 'Align items', kind: 'segments', when: isFlex,
hint: 'Across the flow',
options: [
{ value: 'flex-start', label: 'Start', glyph: '⤒' },
{ value: 'center', label: 'Centre', glyph: '↕' },
{ value: 'flex-end', label: 'End', glyph: '⤓' },
{ value: 'stretch', label: 'Stretch', glyph: '⇕' },
{ value: 'baseline', label: 'Base', glyph: '⌐' }
] },
{ id: 'justify-content', group: 'layout', prop: 'justify-content', label: 'Justify', kind: 'segments', when: isFlex,
hint: 'Along the flow',
options: [
{ value: 'flex-start', label: 'Start', glyph: '⊢' },
{ value: 'center', label: 'Centre', glyph: '↔' },
{ value: 'flex-end', label: 'End', glyph: '⊣' },
{ value: 'space-between', label: 'Between', glyph: '[ ]' },
{ value: 'space-around', label: 'Around', glyph: '( )' }
] },
{ id: 'gap', group: 'layout', prop: 'gap', label: 'Gap', kind: 'range',
when: (ctx) => isFlex(ctx) || isGrid(ctx),
hint: 'Space between the children' },
{ id: 'position', group: 'layout', prop: 'position', label: 'Position', kind: 'segments',
hint: 'How the box is placed',
options: [
{ value: 'static', label: 'Static', glyph: '▤' },
{ value: 'relative', label: 'Relative', glyph: '⇱' },
{ value: 'absolute', label: 'Absolute', glyph: '⌖' },
{ value: 'fixed', label: 'Fixed', glyph: '⊞' },
{ value: 'sticky', label: 'Sticky', glyph: '⇧' }
] },
{ id: 'box', group: 'spacing', prop: 'padding', label: 'Box model', kind: 'box',
hint: 'Tap an edge, then drag the value' },
{ id: 'width', group: 'size', prop: 'width', label: 'Width', kind: 'range',
keywords: [{ value: 'auto', label: 'Auto' }, { value: '100%', label: '100%' }],
hint: 'The element\'s own width' },
{ id: 'height', group: 'size', prop: 'height', label: 'Height', kind: 'range',
keywords: [{ value: 'auto', label: 'Auto' }],
hint: 'The element\'s own height' },
{ id: 'border-radius', group: 'size', prop: 'border-radius', label: 'Corners', kind: 'range',
hint: 'Rounds the corners' },
{ id: 'font-size', group: 'text', prop: 'font-size', label: 'Size', kind: 'range',
hint: 'The type size' },
{ id: 'font-weight', group: 'text', prop: 'font-weight', label: 'Weight', kind: 'segments',
hint: 'How heavy the type is',
options: [
{ value: '300', label: '300', glyph: 'Aa' },
{ value: '400', label: '400', glyph: 'Aa' },
{ value: '500', label: '500', glyph: 'Aa' },
{ value: '600', label: '600', glyph: 'Aa' },
{ value: '700', label: '700', glyph: 'Aa' },
{ value: '800', label: '800', glyph: 'Aa' }
] },
{ id: 'line-height', group: 'text', prop: 'line-height', label: 'Line height', kind: 'range',
hint: 'Space between the lines' },
{ id: 'letter-spacing', group: 'text', prop: 'letter-spacing', label: 'Tracking', kind: 'range',
hint: 'Space between the letters' },
{ id: 'text-align', group: 'text', prop: 'text-align', label: 'Align', kind: 'segments',
hint: 'Where the text sits',
options: [
{ value: 'left', label: 'Left', glyph: '⇤' },
{ value: 'center', label: 'Centre', glyph: '↔' },
{ value: 'right', label: 'Right', glyph: '⇥' },
{ value: 'justify', label: 'Justify', glyph: '☰' }
] },
{ id: 'color', group: 'text', prop: 'color', label: 'Text colour', kind: 'colour',
hint: 'The type colour' },
{ id: 'background-color', group: 'colour', prop: 'background-color', label: 'Background', kind: 'colour',
hint: 'Behind the content' },
{ id: 'background-image', group: 'colour', prop: 'background-image', label: 'Background image', kind: 'image',
hint: 'A gradient or an image, painted over the background colour' },
{ id: 'border-color', group: 'colour', prop: 'border-color', label: 'Border colour', kind: 'colour',
hint: 'The border line' },
{ id: 'opacity', group: 'effects', prop: 'opacity', label: 'Opacity', kind: 'range',
hint: 'How see-through it is' },
{ id: 'box-shadow', group: 'effects', prop: 'box-shadow', label: 'Shadow', kind: 'segments',
hint: 'Depth around the box',
options: [
{ value: 'none', label: 'None', glyph: '·' },
{ value: '0 1px 2px rgba(0, 0, 0, 0.18)', label: 'Soft', glyph: '▁' },
{ value: '0 4px 12px rgba(0, 0, 0, 0.22)', label: 'Lifted', glyph: '▂' },
{ value: '0 12px 32px rgba(0, 0, 0, 0.28)', label: 'Floating', glyph: '▃' }
] },
{ id: 'border-style', group: 'effects', prop: 'border-style', label: 'Border style', kind: 'segments',
hint: 'The kind of border line',
options: [
{ value: 'none', label: 'None', glyph: '·' },
{ value: 'solid', label: 'Solid', glyph: '▬' },
{ value: 'dashed', label: 'Dashed', glyph: '▨' },
{ value: 'dotted', label: 'Dotted', glyph: '⋯' }
] },
{ id: 'border-width', group: 'effects', prop: 'border-width', label: 'Border width', kind: 'range',
hint: 'How thick the border is' }
];

// controlsFor — the controls in one group that apply to this element. The order
// is CONTROLS' own order, so a group's rows are stable between renders (a
// re-ordered list under a moving finger is the worst kind of layout shift).
export function controlsFor(groupId, ctx) {
return CONTROLS.filter((c) => c.group === groupId && (!c.when || c.when(ctx || {})));
}

// defaultGroup — the group the surface opens on. Layout for a flex/grid
// container (its rows are the ones that move things), Spacing otherwise: the
// two questions a phone user actually opens the Styles tab with are "lay this
// out" and "give it room".
export function defaultGroup(ctx) {
return (isFlex(ctx) || isGrid(ctx)) ? 'layout' : 'spacing';
}

// boxEdges — the eight edge values of the box editor, in ring order. Each edge
// is a real longhand with its own value, because that is what the CSSOM stores
// when `padding: 10px 14px` is written — so an asymmetric box shows four
// different numbers and each one is editable on its own.
export function boxEdges(ctx) {
const out = [];
for (const box of BOXES) {
for (const side of SIDES) {
const prop = box.id + '-' + side;
out.push({
box: box.id,
side,
prop,
label: box.label + ' ' + SIDE_LABEL[side].toLowerCase(),
value: readValue(prop, ctx),
isSet: isDeclared(prop, ctx)
});
}
}
return out;
}

// edgeValue — one edge's value from a boxEdges() list, or ''.
export function edgeValue(edges, box, side) {
const row = (edges || []).find((e) => e.box === box && e.side === side);
return row ? row.value : '';
}

// LIBRARY_GROUPS — the categories the "Add property" sheet groups its cards by.
// 'all' is the first tab, because a search and an overview are the same gesture
// on a phone: open, scan, tap.
export const LIBRARY_GROUPS = [
{ id: 'all', label: 'All' },
{ id: 'layout', label: 'Layout' },
{ id: 'spacing', label: 'Spacing' },
{ id: 'size', label: 'Size' },
{ id: 'text', label: 'Type' },
{ id: 'colour', label: 'Colour' },
{ id: 'effects', label: 'Effects' }
];

// LIBRARY — the property cards the Add-property sheet offers, each with the
// group it belongs to, a one-line answer to "what does this do", and the kind of
// mini diagram its card draws (`preview`). This is not a CSS reference: it is
// the set of properties a person reaches for on a phone, in the order they reach
// for them. Anything outside it is still reachable by typing a name in the
// card sheet's search field or in the editor's property field.
export const LIBRARY = [
{ prop: 'display', group: 'layout', label: 'Display', blurb: 'How the box is laid out', preview: 'flex' },
{ prop: 'position', group: 'layout', label: 'Position', blurb: 'Static, relative, absolute…', preview: 'position' },
{ prop: 'flex-direction', group: 'layout', label: 'Flex direction', blurb: 'Which way the children flow', preview: 'flex' },
{ prop: 'align-items', group: 'layout', label: 'Align items', blurb: 'Line the children up across', preview: 'flex' },
{ prop: 'justify-content', group: 'layout', label: 'Justify content', blurb: 'Spread the children along', preview: 'flex' },
{ prop: 'gap', group: 'layout', label: 'Gap', blurb: 'Space between the children', preview: 'gap' },
{ prop: 'flex-wrap', group: 'layout', label: 'Flex wrap', blurb: 'Let the children wrap', preview: 'flex' },
{ prop: 'padding', group: 'spacing', label: 'Padding', blurb: 'Space inside the element', preview: 'padding' },
{ prop: 'margin', group: 'spacing', label: 'Margin', blurb: 'Space outside the element', preview: 'margin' },
{ prop: 'margin-top', group: 'spacing', label: 'Row gap', blurb: 'Space between rows', preview: 'gap' },
{ prop: 'width', group: 'size', label: 'Width', blurb: 'The element\'s own width', preview: 'size' },
{ prop: 'height', group: 'size', label: 'Height', blurb: 'The element\'s own height', preview: 'size' },
{ prop: 'min-height', group: 'size', label: 'Min height', blurb: 'Never shorter than this', preview: 'size' },
{ prop: 'max-width', group: 'size', label: 'Max width', blurb: 'Never wider than this', preview: 'size' },
{ prop: 'border-radius', group: 'size', label: 'Border radius', blurb: 'Rounds the corners', preview: 'radius' },
{ prop: 'font-size', group: 'text', label: 'Font size', blurb: 'The type size', preview: 'text' },
{ prop: 'font-weight', group: 'text', label: 'Font weight', blurb: 'How heavy the type is', preview: 'weight' },
{ prop: 'line-height', group: 'text', label: 'Line height', blurb: 'Space between the lines', preview: 'text' },
{ prop: 'letter-spacing', group: 'text', label: 'Letter spacing', blurb: 'Space between the letters', preview: 'text' },
{ prop: 'text-align', group: 'text', label: 'Text align', blurb: 'Where the text sits', preview: 'text' },
{ prop: 'font-family', group: 'text', label: 'Font family', blurb: 'The face the type is set in', preview: 'weight' },
{ prop: 'color', group: 'colour', label: 'Colour', blurb: 'The type colour', preview: 'colour' },
{ prop: 'background-color', group: 'colour', label: 'Background', blurb: 'Behind the content', preview: 'colour' },
{ prop: 'background-image', group: 'colour', label: 'Background image', blurb: 'A gradient or an image', preview: 'gradient' },
{ prop: 'border-color', group: 'colour', label: 'Border colour', blurb: 'The border line', preview: 'border' },
{ prop: 'opacity', group: 'effects', label: 'Opacity', blurb: 'How see-through it is', preview: 'opacity' },
{ prop: 'box-shadow', group: 'effects', label: 'Box shadow', blurb: 'Depth around the element', preview: 'shadow' },
{ prop: 'border', group: 'effects', label: 'Border', blurb: 'A line around the element', preview: 'border' },
{ prop: 'border-style', group: 'effects', label: 'Border style', blurb: 'Solid, dashed, dotted…', preview: 'border' },
{ prop: 'overflow', group: 'effects', label: 'Overflow', blurb: 'What happens past the edge', preview: 'overflow' },
{ prop: 'transition', group: 'effects', label: 'Transition', blurb: 'How changes animate', preview: 'none' },
{ prop: 'cursor', group: 'effects', label: 'Cursor', blurb: 'Pointer shape on hover', preview: 'none' }
];

// searchLibrary — the cards a query and a category leave, in library order. The
// match is on the property name, the label and the blurb, so `space`, `round`
// and `background` all find their cards without knowing the CSS name.
export function searchLibrary(query, groupId, library) {
const q = String(query || '').trim().toLowerCase();
const rows = (library || LIBRARY).filter((row) => {
if (groupId && groupId !== 'all' && row.group !== groupId) return false;
if (!q) return true;
return (row.prop + ' ' + row.label + ' ' + row.blurb).toLowerCase().indexOf(q) >= 0;
});
return rows;
}

// libraryRow — a card with the element's state attached: the value it has now
// (from the panel's own read, so a card can say "16px" instead of "already
// added" and leave the user guessing).
export function libraryRow(entry, ctx) {
// The *declared* value, not the resolved one: a card that says "already added"
// has to mean "on the element", or the badge would light up for every property
// the page resolves from a class and every card would look already-added. The
// resolved value is the fallback, so the card can still say what it is now.
const declared = readDeclared(entry.prop, ctx);
const value = declared != null ? declared : readValue(entry.prop, ctx);
const set = declared != null;
return {
prop: entry.prop,
group: entry.group,
label: entry.label,
blurb: entry.blurb,
preview: entry.preview || 'none',
value,
isSet: set,
// A card with a value is an *edit* (it opens the sheet on the value the element
// has, exactly like a declared row); a card without one is an *add* (the sheet
// seeds the family's neutral value).
action: set ? 'Edit' : 'Choose',
title: set
? 'Edit ' + entry.label + ' (' + entry.prop + ') — now ' + value
: 'Add ' + entry.label + ' (' + entry.prop + ')'
};
}

// libraryCounts — how many cards each category holds, for the tab chips' counts
// (the same honesty as the panel's other counts: a category that would open an
// empty list is not offered as if it had content).
export function libraryCounts(query, library) {
const counts = {};
for (const g of LIBRARY_GROUPS) counts[g.id] = searchLibrary(query, g.id, library).length;
return counts;
}

// classifyControl — the shape a control's value has, which decides whether the
// control can be dragged: a length or number gets a slider, a colour gets
// swatches, a keyword gets chips. Exported so the surface and the tests read the
// same verdict.
export function classifyControl(prop, value) {
return classify(prop, value);
}
