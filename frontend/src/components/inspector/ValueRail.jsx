// Inspector ValueRail — one changer for every numeric value kind.
//
// The sheet's typed field is the source of truth and Apply is the only thing
// that writes to the page. This component sits above the field and *writes into
// it*: drag the thumb, tap a tick, or nudge, and the field shows the new value
// until the user applies it. That contract is the same as the type switch and
// the suggestion chips — one property, one undo entry, no hidden writes.
//
// It follows the K1 mock: a track with minor ticks at the page's own step, major
// ticks at round numbers, a violet tick for any design token whose value lands
// in range, a 34 px thumb, the page's step stated in the header, and a precision
// segment (1 / 4 / 8) plus a unit chip in the footer. The ± pair lives in the
// sheet's value row (it is the same two buttons for every kind) and moves by the
// same step as the drag.
//
// Only inline styles and a few classes are used — no drag library, because the
// whole gesture is one pointer capture. Everything that can be computed is
// computed by valueRail.js, which is pure and unit-tested.
import { h } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { railRange, railTicks, railLabel, railWritable, valueToRatio, ratioToValue, quantize, snapStep, nudge } from './valueRail.js';
import { classify, formatNumber, unitOptions } from './valueKinds.js';
// PRECISIONS — the segment's steps. 1 px for a placed value, 4 px for a scale
// value, 8 px for a coarse one; the page's own step is always available as a
// "page" entry that uses the index's number.
const PRECISIONS = [1, 4, 8];
// THUMB — the visual and hit sizes. The thumb is 34 px (what a finger sees) and
// the pointer target is the whole 60 px track, so a drag never needs pixel aim.
const THUMB = 34;
const TRACK_TOP = 22;
// MAX_RATIO_STEP — how many decimals a written value keeps. Four is what
// formatNumber already rounds to; this is the rail's own belt-and-braces.
const MAX_DECIMALS = 4;
// pad — a value for an inline style string, so a negative number cannot produce
// `left:-5%` inside a transform.
function pct(ratio) {
return (Math.max(0, Math.min(1, ratio)) * 100).toFixed(2) + '%';
}
// asText — the value the rail writes into the field: a number and its unit.
function asText(n, unit) {
return formatNumber(n) + (unit || '');
}
// ValueRail — the control. Props:
//   prop, value        the declaration being edited (the field's own state)
//   ctx                { step, scale, tokens, rootFontSize, fontSize, size, ... }
//   onChange(text)     rewrites the caller's value field (Apply still commits)
export function ValueRail(props) {
const prop = props.prop || '';
const value = props.value || '';
const ctx = props.ctx || {};
const [precision, setPrecision] = useState(null);
const wrapRef = useRef(null);
const dragRef = useRef(null);
const writable = railWritable(prop, value);
// The range, and the step the drag uses: the user's chosen precision first, then
// the page's own step, then a fine/coarse pair that adapts to the value's size.
const range = writable.ok ? railRange(prop, value, Object.assign({ step: ctx.step }, ctx)) : null;
const chosen = precision != null ? precision : (range && range.step ? range.step : null);
const step = chosen != null ? chosen : snapStep(classify(prop, value).number, { fine: 1, coarse: 8 });
const ticks = range ? railTicks(range, { step, tokens: ctx.tokens || [] }) : { minor: [], major: [], tokens: [] };
const info = classify(prop, value);
const ratio = range ? valueToRatio(info.number, range) : 0;
// The off-scale ghost: the page's nearest on-scale value, drawn dashed and not
// draggable. `ctx.nearest` comes from the same snapValue reading the sheet's
// hint uses, so the ring and the hint can never disagree.
const ghost = (() => {
if (!range || ctx.nearest == null) return null;
const n = Number(ctx.nearest);
if (!Number.isFinite(n)) return null;
if (n < range.min || n > range.max) return null;
return { number: n, ratio: valueToRatio(n, range) };
})();
// unitOptions gives the px ⇄ rem ⇄ % cycle, and it is the same control the type
// switch uses — so a rail-edited value and a switch-edited value end up in the
// same unit with the same base font size.
const units = unitOptions(prop, value, ctx);
function write(n) {
if (!range) return;
const clamped = quantize(n, null, range);
const next = asText(Number(clamped.toFixed(MAX_DECIMALS)), range.unit);
// A no-op drag (the thumb has not moved) must not churn the value field, or a
// tap on the track would clear a half-typed value.
if (next !== value) props.onChange(next);
}
// ratioAt — the pointer's position as a rail ratio. Read from the live
// bounding box on every move, because the sheet can be resized by the keyboard
// and a cached rect would make the thumb drift away from the finger.
function ratioAt(clientX) {
const el = wrapRef.current;
if (!el) return 0;
const rect = el.getBoundingClientRect();
if (!(rect.width > 0)) return 0;
return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}
function moveTo(clientX) {
if (!range) return;
write(ratioToValue(ratioAt(clientX), range, step));
}
function onDown(e) {
if (!range) return;
// Pointer capture is what makes this work without a drag library: the moves
// keep arriving after the finger leaves the 60 px track, and they stop when it
// lifts. `preventDefault` stops the sheet's scroller from stealing the gesture.
if (e.currentTarget.setPointerCapture) {
try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
}
dragRef.current = { id: e.pointerId, moved: false };
e.preventDefault();
moveTo(e.clientX);
}
function onMove(e) {
if (!dragRef.current || dragRef.current.id !== e.pointerId) return;
dragRef.current.moved = true;
e.preventDefault();
moveTo(e.clientX);
}
function onUp(e) {
if (!dragRef.current) return;
dragRef.current = null;
if (e.currentTarget.releasePointerCapture) {
try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
}
}
// Tapping the tick labels is the precise version of tapping the track: the label
// carries the exact number, so the value lands on it whatever the mapping does.
function tap(value) {
if (!range) return;
const n = Number(value);
if (Number.isFinite(n)) write(n);
}
if (!writable.ok) {
// The mock's last rung: no rail, the typed field only, and a line saying why.
return h('p', { class: 'inspector__rail-note' }, 'No rail: ' + writable.reason + '.');
}
const label = range ? railLabel(info.number, range) : '';
return h('div', { class: 'inspector__rail' },
h('div', { class: 'inspector__rail-head' },
h('span', { class: 'inspector__rail-kind' }, range.family),
props.from != null && String(props.from) !== String(value)
? h('span', { class: 'inspector__rail-was' }, String(props.from))
: null,
h('span', { class: 'inspector__rail-now' }, label || value),
h('span', { class: 'inspector__rail-ev' },
step != null ? (precision != null ? precision + ' ' + (range.unit || '') + ' step' : (range.step ? 'page step ' + range.step + (range.unit || '') : 'fine 1'))
: 'fine')
),
h('div', {
class: 'inspector__rail-wrap',
ref: wrapRef,
role: 'slider',
tabIndex: 0,
'aria-label': 'Value rail for ' + prop,
'aria-valuemin': String(range.min),
'aria-valuemax': String(range.max),
'aria-valuenow': info.number != null ? String(info.number) : '',
'aria-valuetext': label,
onPointerDown: onDown,
onPointerMove: onMove,
onPointerUp: onUp,
onPointerCancel: onUp,
// Arrow keys are not a phone gesture, but they cost nothing and make the control
// usable with a keyboard on a tablet with a case.
onKeyDown: (e) => {
if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); write(nudge(info.number, 1, step, range)); }
if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); write(nudge(info.number, -1, step, range)); }
}
},
h('div', { class: 'inspector__rail-track' }),
h('div', { class: 'inspector__rail-fill', style: { width: pct(ratio) } }),
ticks.minor.map((v) => h('span', {
class: 'inspector__rail-tick',
key: 't' + v,
style: { left: pct(valueToRatio(v, range)) }
})),
ticks.major.map((v) => h('button', {
class: 'inspector__rail-major',
type: 'button',
key: 'm' + v,
style: { left: pct(valueToRatio(v, range)) },
title: 'Set ' + prop + ' to ' + formatNumber(v) + (range.unit || ''),
'aria-label': 'Set to ' + formatNumber(v) + (range.unit || ''),
onClick: () => tap(v)
})),
ticks.tokens.map((t) => h('button', {
class: 'inspector__rail-token',
type: 'button',
key: 'k' + t.name,
style: { left: pct(t.ratio) },
title: t.name + ' = ' + t.value,
'aria-label': 'Set to ' + t.name + ', which is ' + t.value,
onClick: () => tap(t.number)
})),
ghost
? h('span', {
class: 'inspector__rail-ghost',
style: { left: pct(ghost.ratio) },
'aria-hidden': 'true'
})
: null,
h('span', {
class: 'inspector__rail-thumb',
style: { left: pct(ratio) },
'aria-hidden': 'true'
}, info.number != null ? formatNumber(info.number) : '')
),
h('div', { class: 'inspector__rail-labels' },
ticks.major.map((v) => h('span', { key: 'l' + v, style: { left: pct(valueToRatio(v, range)) } }, formatNumber(v))),
ticks.tokens.map((t) => h('span', { class: 'is-token', key: 'n' + t.name, style: { left: pct(t.ratio) } }, t.name))
),
h('div', { class: 'inspector__rail-foot' },
h('div', { class: 'inspector__rail-seg', role: 'group', 'aria-label': 'Snap step' },
PRECISIONS.map((n) => h('button', {
class: 'inspector__rail-segbtn' + (step === n ? ' is-on' : ''),
type: 'button',
key: 'p' + n,
'aria-pressed': String(step === n),
title: 'Snap to ' + n + (range.unit || '') + ' steps',
onClick: () => { setPrecision(n); if (range) write(quantize(info.number, n, range)); }
}, n + ' ' + (range.unit || ''))),
range && range.step
? h('button', {
class: 'inspector__rail-segbtn' + (precision == null ? ' is-on' : ''),
type: 'button',
title: 'Use the page\'s own ' + range.step + (range.unit || '') + ' step',
'aria-pressed': String(precision == null),
onClick: () => { setPrecision(null); }
}, 'page')
: null
),
units.length > 1
? h('div', { class: 'inspector__rail-units', role: 'group', 'aria-label': 'Unit' },
units.map((u) => h('button', {
class: 'inspector__rail-unitchip' + (u.current ? ' is-on' : ''),
type: 'button',
key: u.unit,
disabled: !u.ok,
'aria-pressed': String(!!u.current),
title: u.current ? u.unit + ' — the unit in use' : (u.ok ? 'Rewrite as ' + u.value : 'Not available: ' + u.reason),
onClick: () => { if (u.ok) props.onChange(u.value); }
}, u.unit))
)
: null,
ctx.scaleNote
? h('span', { class: 'inspector__rail-mini' }, ctx.scaleNote)
: null
)
);
}
export default ValueRail;
