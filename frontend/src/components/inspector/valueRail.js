// Inspector value rail — one changer for every numeric value kind.
//
// The edit sheet's typed field is the source of truth: it is where a value comes
// from, where a suggestion lands and what Apply commits. What it is bad at is
// *choosing* a number on a phone — the range is invisible, the page's own steps
// are invisible, and the only way to try `14px` instead of `16px` is four taps
// on a keyboard.
//
// This module is the arithmetic behind a rail that fixes that. It is pure: a
// property, a value and a small context in; a range, a position and a CSS string
// out. It never writes to the page and never touches another property.
//
//   railRange(property, value, ctx)        -> { min, max, scale, unit, family, step }
//   valueToRatio(value, range)             -> 0…1, monotonic, exact endpoints
//   ratioToValue(ratio, range, step)       -> a value in the range's unit
//   quantize(value, step, range)           -> the nearest step, clamped
//   snapStep(value, { fine, coarse })      -> the step a drag should use
//   nudge(value, dir, step, range)         -> the value one step away, clamped
//   railTicks(range, ctx)                  -> minor / major / token ticks
//   isLogRange(range)                      -> whether the scale is logarithmic
//   railLabel(value, range)                -> the readout string
//
// Three decisions worth stating:
//
//  * The ranges are per *property family*, not global. `opacity` is 0…1, not
//    0…100 of some imagined "number"; `z-index` starts below zero; a length is
//    0…4× the element's own size, because "how big is this box" is the only
//    length scale a page can be judged against on its own.
//  * A logarithmic scale is used for a range whose max is at least 100× its
//    min — the only case where a linear thumb spends most of its travel on
//    values nobody wants. A range starting at 0 is always linear, because
//    log(0) does not exist and a rail that cannot reach its own minimum is
//    worse than a coarse one.
//  * Everything clamps instead of throwing. A stored value of `9999px` on a
//    0…256 rail resolves to the top of the rail, not to a broken render.
import { classify, formatNumber } from './valueKinds.js';
// LOG_RATIO — how many times larger than its minimum a range must be before the
// log scale is worth it. A 0…20 range is perfectly readable linearly; a
// 1…1000 range is not.
export const LOG_RATIO = 100;
// MAX_TICKS — how many minor ticks a rail will draw. A 0…2000 ms range at a
// 10 ms step is 200 ticks, each ~1.7 px apart on a 360 px phone: below the cap
// they are indistinguishable marks, above it they are a solid bar. The cap is
// what keeps the rail a control rather than a texture, and the step is widened
// when the range cannot take it.
export const MAX_TICKS = 40;
// MAX_MAJOR — round-number labels. Five numbers across a phone rail is the
// most a thumb can aim at and a finger can read.
export const MAX_MAJOR = 5;
// DEFAULT_LENGTH — the px basis for a length rail when the element's own size
// is unknown (a freshly picked node, a property whose size the panel did not
// read). 64 px is a card-sized box, which puts a typical `16px` padding at a
// quarter of the rail.
const DEFAULT_LENGTH = 64;
// RANGES — the per-family bounds, before the value's unit is taken into
// account. `length` is resolved against the element's own size (see ctx.size).
const RANGES = {
opacity: { min: 0, max: 1 },
'line-height': { min: 0, max: 3 },
'z-index': { min: -10, max: 100 },
angle: { min: -180, max: 180 },
hue: { min: 0, max: 360 },
scale: { min: 0, max: 3 },
percent: { min: 0, max: 200 },
time: { min: 0, max: 2000 }
};
// familyOf — which range a property/value pair belongs to. The value matters
// because a length property can hold a percentage and a transform holds several
// different functions; classification is the same one the type switch uses, so
// the rail and the switch never disagree about what a value *is*.
export function familyOf(property, value) {
const prop = String(property || '').trim().toLowerCase();
const info = classify(prop, value);
if (prop === 'opacity' || prop === 'fill-opacity' || prop === 'stroke-opacity') return 'opacity';
if (prop === 'line-height') return 'line-height';
if (prop === 'z-index') return 'z-index';
if (prop === 'hue-rotate' || prop === 'filter' && /hue-rotate\(/i.test(String(value || ''))) return 'hue';
if (/^rotate/.test(prop) || prop.endsWith('-angle') || info.kind === 'angle') return 'angle';
if (info.kind === 'time' || /-duration$|-delay$/.test(prop)) return 'time';
if (info.kind === 'percent') return 'percent';
if (prop === 'scale' || /^scale/.test(prop)) return 'scale';
if (info.kind === 'length') return 'length';
if (info.kind === 'number') return 'number';
return 'length';
}
// sizeBasis — the px size a length rail is scaled against: the element's own
// measured size when the caller read one, else its font size, else the default.
function sizeBasis(ctx) {
const c = ctx || {};
if (Number.isFinite(c.size) && c.size > 0) return c.size;
if (Number.isFinite(c.fontSize) && c.fontSize > 0) return c.fontSize;
return DEFAULT_LENGTH;
}
// toUnit — a px number expressed in the value's own unit, so the rail's bounds
// and the field's text are in the same units. `null` when the unit needs a base
// size the context does not have, which falls back to px.
function toUnit(px, unit, ctx) {
const c = ctx || {};
const u = String(unit || 'px').toLowerCase();
if (u === 'px' || u === '') return px;
if (u === 'rem' && c.rootFontSize) return px / c.rootFontSize;
if (u === 'em' && (c.parentFontSize || c.fontSize)) return px / (c.parentFontSize || c.fontSize);
if (u === 'pt') return px * (72 / 96);
if (u === 'vh' && c.viewportHeight) return (px / c.viewportHeight) * 100;
if (u === 'vw' && c.viewportWidth) return (px / c.viewportWidth) * 100;
return px;
}
// fromUnit — the inverse, for a rail position written back as px-basis numbers.
export function fromUnit(value, unit, ctx) {
const c = ctx || {};
const u = String(unit || 'px').toLowerCase();
if (u === 'px' || u === '') return value;
if (u === 'rem' && c.rootFontSize) return value * c.rootFontSize;
if (u === 'em' && (c.parentFontSize || c.fontSize)) return value * (c.parentFontSize || c.fontSize);
if (u === 'pt') return value * (96 / 72);
if (u === 'vh' && c.viewportHeight) return (value / 100) * c.viewportHeight;
if (u === 'vw' && c.viewportWidth) return (value / 100) * c.viewportWidth;
return value;
}
// railRange — the bounds of the rail for this property and value.
//
// Returns `{ min, max, scale, unit, family, step }`. `scale` is `'log'` or
// `'linear'` (see LOG_RATIO), `step` is the page's own numeric step when the
// caller passed one (`ctx.scale`), and `unit` is the unit the bounds are
// expressed in — which is the value's own unit, so `0.5rem` gets a `0…4rem`
// rail rather than a `0…64px` one with the numbers translated.
export function railRange(property, value, ctx) {
const c = ctx || {};
const info = classify(property, value);
const family = familyOf(property, value);
const unit = info.unit || '';
let min;
let max;
if (family === 'length') {
const basis = sizeBasis(c);
min = 0;
max = toUnit(basis * 4, unit, c);
} else if (family === 'number') {
// A bare number with no family of its own (`flex-grow`, `order`, `aspect-ratio`)
// has no natural bound. The rail still helps: 0…10 covers the values these
// properties take in practice, and the typed field stays available for the
// rest.
const base = RANGES.scale;
min = base.min;
max = base.max;
if (Number.isFinite(info.number) && info.number > max) max = Math.ceil(info.number);
} else {
const base = RANGES[family] || RANGES.scale;
min = base.min;
max = base.max;
// A time in seconds is the same range in a different unit.
if (family === 'time' && unit === 's') { min = min / 1000; max = max / 1000; }
// The value in force is always reachable, even when it sits outside the
// family's usual bounds: a rail the current value cannot be shown on is a
// control that lies about where it is.
if (Number.isFinite(info.number)) {
if (info.number < min) min = info.number;
if (info.number > max) max = info.number;
}
}
if (!(max > min)) max = min + 1;
const step = Number.isFinite(c.step) && c.step > 0 ? c.step : null;
return {
min,
max,
scale: (min > 0 && max / min >= LOG_RATIO) ? 'log' : 'linear',
unit,
family,
step
};
}
// isLogRange — whether a range is on the logarithmic scale.
export function isLogRange(range) {
return !!(range && range.scale === 'log' && range.min > 0);
}
// clampUnit — a ratio clamped into 0…1. Every mapping goes through this, which
// is what makes an out-of-range value render at the rail's end instead of
// outside it.
function clampUnit(n) {
if (!Number.isFinite(n)) return 0;
return Math.max(0, Math.min(1, n));
}
// valueToRatio — where a value sits on the rail, 0 at the minimum and 1 at the
// maximum. Monotonic by construction and exact at both endpoints.
//
// A value outside the range clamps: the thumb parks at the end and the readout
// still shows the real number, so the user can see that the value is past the
// rail rather than silently reading a different one.
export function valueToRatio(value, range) {
if (!range) return 0;
const n = Number(value);
if (!Number.isFinite(n)) return 0;
if (isLogRange(range)) {
const v = Math.max(n, range.min);
return clampUnit(Math.log(v / range.min) / Math.log(range.max / range.min));
}
return clampUnit((n - range.min) / (range.max - range.min));
}
// ratioToValue — the inverse, with an optional step to quantize to. The step is
// applied *after* the mapping, so a rail whose step is 4 lands on 4 and not on
// "whatever the pixel worked out to".
export function ratioToValue(ratio, range, step) {
if (!range) return 0;
const r = clampUnit(Number(ratio));
let n;
if (isLogRange(range)) {
n = range.min * Math.pow(range.max / range.min, r);
} else {
n = range.min + r * (range.max - range.min);
}
return quantize(n, step, range);
}
// quantize — the value rounded to the nearest step and clamped into the range,
// as a number (the caller formats it). Without a step the value is returned
// clamped but untouched, so a rail with no step still moves continuously.
export function quantize(value, step, range) {
const n = Number(value);
if (!Number.isFinite(n)) return range ? range.min : 0;
const lo = range ? range.min : -Infinity;
const hi = range ? range.max : Infinity;
let out = Math.max(lo, Math.min(hi, n));
if (Number.isFinite(step) && step > 0) {
out = lo + Math.round((out - lo) / step) * step;
// The rounding can land above the top or below the bottom by half a step.
out = Math.max(lo, Math.min(hi, out));
}
return Math.round(out * 1e4) / 1e4;
}
// STEP_LADDER — the three steps a rail's precision segment offers, fine → coarse.
//
// One fallback cannot serve every family: `opacity` is 0…1, so a 1 unit step
// makes the thumb a two-position switch (only 0 and 1 are reachable), while a
// 0…2000 ms rail needs a coarse step or the whole gesture is 2 px of travel.
// So the segment is per family, and `1 px | 4 px | 8 px` in K1 is simply the
// length entry — an opacity rail offers `0.01 | 0.05 | 0.1` in the same place.
export const STEP_LADDER = {
  length: [1, 4, 8],
  number: [1, 5, 10],
  opacity: [0.01, 0.05, 0.1],
  'line-height': [0.05, 0.1, 0.5],
  'z-index': [1, 5, 10],
  time: [10, 50, 100],
  angle: [1, 15, 45],
  hue: [1, 15, 30],
  scale: [0.01, 0.05, 0.1],
  percent: [1, 5, 10]
};
// DRAG_STEP — the step a *drag* uses by default, and the value magnitude above
// which it switches to the coarse one. Kept separate from the ladder because
// they answer different questions: the ladder is the three taps the user can
// choose between, this is which of them the thumb starts on.
//
// The threshold is on the value's own magnitude rather than a multiple of the
// step: an opacity of 0.5 is "large" next to a 0.05 step and must still move in
// 0.05, so a family whose range is inherently small states it with no switch at
// all (the mock's flat `0–1 at 0.05` and `0–3 at 0.05`).
export const DRAG_STEP = {
  length: { fine: 1, coarse: 8, above: 32 },
  number: { fine: 1, coarse: 10, above: 50 },
  opacity: { fine: 0.05, coarse: 0.05 },
  'line-height': { fine: 0.05, coarse: 0.05 },
  'z-index': { fine: 1, coarse: 1 },
  time: { fine: 10, coarse: 50, above: 200 },
  angle: { fine: 1, coarse: 15, above: 90 },
  hue: { fine: 1, coarse: 15, above: 90 },
  scale: { fine: 0.01, coarse: 0.05, above: 1 },
  percent: { fine: 1, coarse: 5, above: 50 }
};
// stepLadder — the segment's three steps for a family, or the length ones. A
// family the table does not list still gets a usable segment rather than an
// empty control.
export function stepLadder(family) {
return STEP_LADDER[String(family || '')] || STEP_LADDER.length;
}
// familyStep — the drag's step for a value when the page has no scale of its
// own. `value` is the number in force, so a large one moves in the coarse step
// and a small one stays reachable at the fine step.
export function familyStep(value, family) {
const rule = DRAG_STEP[String(family || '')] || DRAG_STEP.length;
const n = Math.abs(Number(value));
if (!Number.isFinite(n) || !Number.isFinite(rule.above) || n <= rule.above) return rule.fine;
return rule.coarse;
}
// snapStep — which step a drag should use, given a fine and a coarse option.
//
// The rule: use the fine step while the value is small enough that a coarse one
// would make it unreachable, and the coarse step above that. `opts.threshold` is
// how many coarse steps a value must span before coarse takes over — 4 by
// default, so a 4 px rail stays fine up to 16 px and switches above it. A
// caller that already knows which step it wants passes it and skips this.
export function snapStep(value, opts) {
const o = opts || {};
const fine = Number.isFinite(o.fine) && o.fine > 0 ? o.fine : null;
const coarse = Number.isFinite(o.coarse) && o.coarse > 0 ? o.coarse : null;
if (!fine) return coarse;
if (!coarse) return fine;
const threshold = Number.isFinite(o.threshold) && o.threshold > 0 ? o.threshold : 4;
const n = Math.abs(Number(value));
if (!Number.isFinite(n)) return fine;
return n <= coarse * threshold ? fine : coarse;
}
// nudge — the value one step away, clamped into the range. This is the ± pair
// beside the rail: it uses the same step as the drag, so tapping + and dragging
// reach the same values.
export function nudge(value, dir, step, range) {
const n = Number(value);
const lo = range ? range.min : -Infinity;
const hi = range ? range.max : Infinity;
const base = Number.isFinite(n) ? n : (range ? range.min : 0);
const size = Number.isFinite(step) && step > 0 ? step : 1;
const next = base + (dir < 0 ? -size : size);
return quantize(Math.max(lo, Math.min(hi, next)), step, range);
}
// tickValues — the minor ticks: every `step` from the range's start, capped at
// MAX_TICKS by widening the step. Returns numbers in the range's unit.
export function tickValues(range, step) {
if (!range) return [];
let size = Number.isFinite(step) && step > 0 ? step : null;
if (!size) {
// No page step: ten evenly spaced ticks, which is the most a phone rail can
// show without implying precision the range does not have.
size = (range.max - range.min) / 10;
}
const span = range.max - range.min;
let count = Math.floor(span / size) + 1;
if (count > MAX_TICKS) {
// Widen to the next step that fits, keeping the ticks on multiples of the
// original step so they still mean something.
const multiple = Math.ceil(count / MAX_TICKS);
size *= multiple;
count = Math.floor(span / size) + 1;
}
const out = [];
for (let i = 0; i < count; i++) out.push(Math.round((range.min + i * size) * 1e4) / 1e4);
return out;
}
// majorValues — the round-number labels. Round numbers are 10s, 25s, 50s and
// 100s of the range's span, chosen so at most MAX_MAJOR fit: a rail labelled
// `0 10 20 …` is readable, one labelled `0 3.7 7.4 …` is not.
export function majorValues(range) {
if (!range) return [];
const span = range.max - range.min;
if (!(span > 0)) return [range.min];
const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
let step = candidates[candidates.length - 1];
for (const c of candidates) {
if (span / c <= MAX_MAJOR) { step = c; break; }
}
const out = [];
const start = Math.ceil(range.min / step) * step;
for (let v = start; v <= range.max + 1e-9; v += step) {
out.push(Math.round(v * 1e4) / 1e4);
if (out.length > MAX_MAJOR + 1) break;
}
// The endpoints are always meaningful on a bounded rail, so they are added when
// they are not already there and the labels would otherwise start inside.
if (out.length <= 1) return [range.min, range.max];
return out;
}
// railTicks — everything the track draws in one call: the minor ticks, the
// major (labelled, round-number) ticks, and the design tokens whose value lands
// inside the range. Tokens are the violet marks in the mock, and they are the
// reason the rail is worth having over a plain slider: `--space-3` is where the
// thumb should go.
//
// `ctx.tokens` is the caller's list (`{ name, value }`, from valueIndex) and
// `ctx.step` the page's step. Both are optional: without tokens the rail is a
// slider with the page's steps, which is still better than a bare one.
export function railTicks(range, ctx) {
const c = ctx || {};
const minor = tickValues(range, c.step);
const major = majorValues(range);
const tokens = [];
for (const t of c.tokens || []) {
const info = classify('x', t && t.value);
if (!info || info.number == null) continue;
if (info.unit && range.unit && info.unit !== range.unit) continue;
const n = info.number;
if (n < range.min || n > range.max) continue;
const ratio = valueToRatio(n, range);
if (!tokens.some((x) => Math.abs(x.number - n) < 1e-9)) {
tokens.push({ name: String(t.name || ''), value: formatNumber(n) + range.unit, number: n, ratio });
}
}
return { minor, major, tokens };
}
// unitEquivalent — the same value written in another unit, for the readout the
// mock's K1 footer prints beside the unit chips: `px  = 0.875rem`.
//
// The list is `unitOptions`' own answer (valueKinds.js), so the footer can only
// ever show a conversion that a chip in the same row would actually write — the
// readout and the control cannot disagree. A unit whose base size the inspector
// has not read comes back `ok: false` and is skipped rather than guessed, and
// the first *convertible* alternative wins, which is the cycle's own order.
export function unitEquivalent(options) {
for (const o of options || []) {
if (o && !o.current && o.ok && o.value) return String(o.value);
}
return '';
}

// BOX_FRACTIONS — the element's own box, offered as snap targets: ¼, ½ and 1 of
// its size. They are the third source the mock names beside the page's values
// and its tokens (`snap = page values + tokens + element box fractions`), and
// they answer a question neither of those can: "half of *this* card is 56 px".
export const BOX_FRACTIONS = [
  { fraction: 0.25, label: '¼' },
  { fraction: 0.5, label: '½' },
  { fraction: 1, label: '1' }
];
// fractionSnaps — the box fractions that land inside this rail, as
// `{ label, fraction, number, ratio }`.
//
// Only for a length, and only when the caller read the element's own size: the
// fractions are a statement about *this* element, so falling back to the rail's
// default basis would invent three targets that mean nothing. The value is
// derived from the range rather than from the context, because `railRange` has
// already expressed its maximum in the value's own unit — `range.max / 4` is the
// element's size in that unit, whatever unit and conversion produced it.
export function fractionSnaps(range, ctx) {
const c = ctx || {};
if (!range || range.family !== 'length') return [];
if (!(Number.isFinite(c.size) && c.size > 0)) return [];
const basis = range.max / 4;
const out = [];
for (const f of BOX_FRACTIONS) {
const n = Math.round(basis * f.fraction * 1e4) / 1e4;
if (n < range.min || n > range.max) continue;
out.push({ label: f.label, fraction: f.fraction, number: n, ratio: valueToRatio(n, range) });
}
return out;
}
// TIME_PRESETS — the durations a transition actually uses. The mock lists
// 100/150/200/300 ms, and they are worth a tap because they are the values a
// designer names ("a quick fade is 150") and because hitting 150 ms on a
// 0…2000 ms rail by dragging is not a realistic gesture.
export const TIME_PRESETS = [100, 150, 200, 300];
// timePresets — those durations as `{ number, label }` in the rail's own unit,
// with the ones outside the range dropped. A rail already in seconds gets
// `0.1s`, not `100ms`, because the chip writes what the field would hold.
export function timePresets(range, ctx) {
if (!range || range.family !== 'time') return [];
const inSeconds = String(range.unit || '').toLowerCase() === 's';
const out = [];
for (const ms of TIME_PRESETS) {
const n = Math.round((inSeconds ? ms / 1000 : ms) * 1e4) / 1e4;
if (n < range.min || n > range.max) continue;
out.push({ number: n, label: formatNumber(n) + (range.unit || '') });
}
return out;
}
// SLOW_DRAG_SPEED — the pointer speed, in CSS px per millisecond, below which a
// drag counts as *slow* and moves in the family's finest step.
//
// A 340 px rail over a 0…32 px range is about 10 px per unit, so the coarse step
// is what makes a drag usable and the fine step is what makes 14 vs 13 possible
// at all. The mock's answer is the gesture rather than a mode: "drag for coarse
// (whole steps); drag slowly for fine (1 px)". 0.25 px/ms is roughly a deliberate
// half-second sweep across a third of the track — fast enough to feel like a
// drag, slow enough that it is clearly aimed.
export const SLOW_DRAG_SPEED = 0.25;
// DOUBLE_TAP_MS / DOUBLE_TAP_PX — what counts as a double-tap on the track. The
// position matters as well as the interval: two taps at opposite ends of the
// rail are two decisions, not one.
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;
// HOLD_MS — how long a press on a tick has to last to count as a hold (the
// mock's "tap-hold a tick locks to it"). 500 ms is long enough not to fire on a
// tap, short enough not to feel stuck.
export const HOLD_MS = 500;
// dragStepFor — the step a drag is currently using, and whether it is the fine
// one. `opts.step` is the step already in force (a precision the user picked, or
// the page's own); a slow drag overrides it with the family's finest, because
// aiming is a request for precision that outranks a remembered setting.
export function dragStepFor(speed, opts) {
const o = opts || {};
const ladder = stepLadder(o.family);
const n = Math.abs(Number(speed));
const slow = Number.isFinite(n) && n < SLOW_DRAG_SPEED;
const base = Number.isFinite(o.step) && o.step > 0 ? o.step : ladder[0];
return { step: slow ? ladder[0] : base, fine: slow };
}
// isDoubleTap — whether a tap continues the previous one. `prev` is
// `{ at, x }` in milliseconds and CSS px; a missing or stale one is not a
// double-tap.
export function isDoubleTap(prev, next) {
if (!prev || !next) return false;
const dt = Math.abs(Number(next.at) - Number(prev.at));
const dx = Math.abs(Number(next.x) - Number(prev.x));
if (!Number.isFinite(dt) || !Number.isFinite(dx)) return false;
return dt <= DOUBLE_TAP_MS && dx <= DOUBLE_TAP_PX;
}
// railLabel — the readout beside the rail, in the mock's shape: the number and
// its unit, no trailing zeros. A `null` ratio (an unparsable value) reads as an
// empty string so the control shows nothing rather than a zero.
export function railLabel(value, range) {
if (value == null || value === '') return '';
const n = Number(value);
if (!Number.isFinite(n)) return String(value);
return formatNumber(n) + ((range && range.unit) || '');
}
// railWritable — whether this value can have a rail at all. The mock's fallback
// ladder ends at "the value cannot be parsed: typed field only, raw value
// preserved, an inline note saying why there is no rail", and this is the check
// that produces that note instead of a control with no effect.
export function railWritable(property, value) {
const info = classify(property, value);
if (!info || info.number == null) {
return { ok: false, reason: 'this value is not a number, so there is nothing to drag' };
}
if (info.kind === 'keyword' || info.kind === 'color' || info.kind === 'custom'
|| info.kind === 'expression' || info.kind === 'unknown') {
return { ok: false, reason: 'a ' + info.kind + ' value has no numeric range' };
}
return { ok: true, reason: '' };
}
