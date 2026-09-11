// Inspector snapping — put the value on the page's own scale.
//
// The value index (valueIndex.js) reports the values a page already uses for a
// property and the GCD step between them. That is evidence, but the user still
// types a free number: `13px` in a design whose scale is 4/8/12/16.
//
// This module turns the step into arithmetic:
//
//   isOnScale(value, scale)                     -> bool
//   nearestOnScale(value, scale)                -> { number, distance } | null
//   snapValue(property, value, scale, opts)     -> { value, snapped, onScale,
//                                                    offScale, nearest, distance, ... }
//   stepFor(scale, precision)                   -> number | null
//   stepValue(property, value, dir, step)       -> string | null
//   snapNote(result)                            -> the one-line explanation
//
// Two rules make it usable rather than annoying:
//
//  * Snapping never happens silently. `snapValue` reports the honest distance
//    and leaves the value alone unless the caller explicitly asks for the snap
//    (`opts.snapTo`), which is what the sheet's "snap to 16px" button does.
//  * The step the page implies beats ±1 — that is the whole point — but an
//    explicitly chosen precision (the rail's 1 px / 4 px / 8 px segment) beats
//    the page, because a deliberated choice outranks an inferred one.
//
// Everything is pure: numbers and plain objects in, plain objects out. A value
// whose kind is not numeric, or a property whose page values share no step, is
// reported as unsnappable with a reason instead of a guessed number.
import { classify, formatNumber } from './valueKinds.js';
// MIN_STEP — a scale step at or below this is noise (a page of pixel-perfect
// values can report a GCD of 0.5), so it is not offered as a snapping target.
export const MIN_STEP = 0.5;
// precisionOf — how many decimals two numbers have to agree on to be "the same
// value" on a scale. The scale carries the decimals of the values it was built
// from, so `1.5` and `1.50` compare equal while `14` and `14.5` do not.
function precisionOf(scale) {
const d = scale && Number.isFinite(scale.decimals) ? scale.decimals : 0;
return Math.min(Math.max(d, 0), 4);
}
// roundTo — the value rounded to the scale's own precision, which is how a
// float-noise compare (`0.30000000000000004`) is avoided without losing the
// distinction between 1.5 and 1.55 on a scale that has 2 decimals.
export function roundTo(n, decimals) {
if (!Number.isFinite(n)) return n;
const f = Math.pow(10, decimals || 0);
return Math.round(n * f) / f;
}
// usableScale — a scale is usable when it has a positive step and at least two
// values. One value says nothing about a scale (see numericScale), and a scale
// without a step has nothing to snap to.
export function usableScale(scale) {
return !!(scale && Number.isFinite(scale.step) && scale.step >= MIN_STEP
&& Array.isArray(scale.values) && scale.values.length > 1);
}
// scaleNumbers — the scale's values as numbers, sorted, for the searches below.
function scaleNumbers(scale) {
const out = [];
for (const v of (scale && scale.values) || []) {
const n = typeof v === 'number' ? v : Number(v);
if (Number.isFinite(n)) out.push(n);
}
out.sort((a, b) => a - b);
return out;
}
// isOnScale — is this value one of the page's steps?
//
// A value on the scale (or a multiple of the step that lands on a scale value)
// does not need the snap hint. Only the scale's own values count: `12px` on a
// 4 px scale whose page values are 4/8/16 is *not* on the scale, even though it
// is a multiple of the step — saying otherwise would hide the nearest-value
// evidence the user came for.
export function isOnScale(value, scale) {
if (!usableScale(scale)) return false;
const p = numberIn(value, scale.unit);
if (!p) return false;
return scaleNumbers(scale).some((n) => n === roundTo(p.n, precisionOf(scale)));
}
// numberIn — the value as a number in the scale's unit, or null.
//
// A *unitless* number adopts the scale's unit: the rail and the steppers write
// bare numbers into the field (`14` under a `4 px step` header), so refusing to
// compare those would turn the common case into "off scale" with no hint. A
// value carrying a *different* unit is a null instead — `16rem` against a px
// scale is a real mismatch, and converting it would need a base size this
// module does not have.
function numberIn(value, unit) {
const p = classify('x', value);
if (!p || p.number == null) return null;
const want = unit || '';
const vUnit = p.unit || want;
if (want && vUnit !== want) return null;
return { n: p.number, unit: vUnit, raw: p.raw, kind: p.kind };
}
// nearestOnScale — the closest value on the page's scale, and how far off the
// given value is. Ties resolve to the *lower* value so the answer is stable
// between renders (a hint that flips between two candidates while the user
// types is worse than an arbitrary but fixed choice).
export function nearestOnScale(value, scale) {
if (!usableScale(scale)) return null;
const p = numberIn(value, scale.unit);
if (!p) return null;
const numbers = scaleNumbers(scale);
let best = null;
for (const n of numbers) {
const distance = Math.abs(p.n - n);
const signed = n - p.n;
if (!best
|| distance < best.distance
|| (distance === best.distance && signed < 0 && best.signed > 0)) {
best = { number: n, distance: roundTo(distance, 4), signed };
}
}
if (!best) return null;
return {
number: best.number,
value: formatNumber(best.number) + (scale.unit || ''),
distance: best.distance,
distanceText: formatNumber(best.distance) + (scale.unit || ''),
};
}
// stepFor — the step a stepper should use. The page's own step wins over the
// fallback ±1, and an explicit precision (the rail's segment) wins over both.
export function stepFor(scale, precision) {
if (Number.isFinite(precision) && precision > 0) return precision;
if (usableScale(scale)) return scale.step;
return null;
}
// stepValue — the value one step up or down, or null when the value is not a
// number the stepper can move. Negative results clamp at 0 rather than
// producing an invalid `-4px` for a padding, and the result is formatted with
// `formatNumber` so `14.000000000000002` never reaches the field.
export function stepValue(value, dir, step) {
const p = classify('x', value);
if (!p || p.number == null) return null;
const size = (Number.isFinite(step) && step > 0) ? step : 1;
const next = p.number + (dir < 0 ? -size : size);
if (!Number.isFinite(next)) return null;
const clamped = next < 0 ? 0 : next;
return formatNumber(roundTo(clamped, 4)) + (p.unit || '');
}
// snapValue — what the sheet should do with the typed value.
//
// Returns the value to write (`value`), whether that differs from what was
// typed (`snapped`), whether the typed value was already a page value
// (`onScale`), and — when it was not — the nearest page value and the honest
// distance. `opts.snapTo` is the user asking for the snap (the "snap to 16px"
// button); without it the field keeps the user's text and the UI shows the
// hint, because silently rewriting what someone typed is the one thing a
// "helper" must not do.
export function snapValue(property, value, scale, opts) {
const o = opts || {};
const raw = String(value == null ? '' : value).trim();
const base = {
value: raw,
from: raw,
to: raw,
snapped: false,
onScale: false,
offScale: false,
nearest: null,
distance: 0,
unit: (scale && scale.unit) || '',
step: null,
reason: ''
};
if (!raw) { base.reason = 'nothing to snap'; return base; }
const p = classify(property, raw);
if (!p || p.number == null) {
base.reason = 'not a number';
return base;
}
if (!usableScale(scale)) {
base.reason = 'this page has no numeric scale for ' + String(property || 'this property');
return base;
}
const unit = scale.unit || '';
// A bare number adopts the scale's unit (see numberIn); a different unit is a
// real mismatch and keeps the field's text.
const vUnit = p.unit || unit;
if (unit && vUnit !== unit) {
// `50%` on a px scale, or `1.5rem` where the page's values are px: there is no
// honest comparison, and converting would need a base size this module does not
// have. The field keeps its text and the note says why.
base.reason = 'the page\'s scale is in ' + unit + ', this value is in ' + (p.unit || 'a bare number');
return base;
}
base.step = scale.step;
base.unit = unit;
const precision = precisionOf(scale);
const typed = p.number;
const onScale = scaleNumbers(scale).some((n) => n === roundTo(typed, precision));
if (onScale) {
base.onScale = true;
base.snapped = false;
base.nearest = { number: typed, value: formatNumber(typed) + unit, distance: 0, distanceText: '0' + unit };
return base;
}
const nearest = nearestOnScale(raw, scale);
base.offScale = true;
base.nearest = nearest;
base.distance = nearest ? nearest.distance : 0;
if (o.snapTo && nearest) {
// The explicit snap: the user pressed the button, so the write is theirs.
base.snapped = true;
base.value = nearest.value;
base.to = nearest.value;
base.reason = 'snapped to the nearest page value';
return base;
}
base.reason = nearest
? 'off the page scale: ' + nearest.value + ' is ' + nearest.distanceText + ' away'
: 'off the page scale';
return base;
}
// snapNote — the one-line state the sheet prints under the value field, in the
// mock's wording: `snapped · 4 px step`, or `nearest 16px · 2px away`.
export function snapNote(result) {
const r = result || {};
if (r.snapped) return 'snapped · ' + formatNumber(r.step) + ' ' + (r.unit || '') + ' step';
if (r.onScale) return 'on scale · ' + formatNumber(r.step) + ' ' + (r.unit || '') + ' step';
if (r.offScale && r.nearest) {
return 'nearest ' + r.nearest.value + ' · ' + r.nearest.distanceText + ' away';
}
return r.reason || '';
}
// scaleStepFor — the page's step for a property, for a caller that has the
// index rather than the scale. Returns null when there is no usable step, which
// is what keeps a one-off value from being described as a scale.
export function scaleStepFor(scale) {
return usableScale(scale) ? scale.step : null;
}
