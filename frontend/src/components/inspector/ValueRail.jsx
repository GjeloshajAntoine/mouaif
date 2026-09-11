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
import { railRange, railTicks, railLabel, railWritable, unitEquivalent, stepLadder, familyStep, fractionSnaps, timePresets, dragStepFor, isDoubleTap, valueToRatio, ratioToValue, quantize, nudge, HOLD_MS, DOUBLE_TAP_MS } from './valueRail.js';
import { classify, formatNumber, unitOptions } from './valueKinds.js';
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
// markStyle — where a *mark* (a tick, not a thumb) sits on the track.
//
// A mark has width, and a mark placed at exactly 100% hangs its own width past
// the rail — which on a 360 px sheet is a real horizontal overflow of the sheet
// body. The marks at the two ends are therefore shifted inside instead of
// centred, the same fix the labels use. The thumb is left alone: it is a circle
// centred on its value, and clipping it would be worse than the mark's 1 px.
function markStyle(ratio, width) {
const r = Math.max(0, Math.min(1, ratio));
if (r <= 0.0001) return { left: pct(r) };
if (r >= 0.9999) return { left: 'calc(100% - ' + width + 'px)' };
return { left: 'calc(' + pct(r) + ' - ' + (width / 2) + 'px)' };
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
// fine — a slow drag is in progress. Held in state because the header has to say
// so while it lasts: the same thumb moves in 1 px and in 4 px during one
// gesture, and a readout that stayed silent would make the jump look like a bug.
const [fine, setFine] = useState(false);
// lock — the tick a hold pinned the value to, if any. Released by the next
// gesture, because it describes the value in force rather than the rail's mode.
const [lock, setLock] = useState(null);
// leftScale — the user has dismissed the off-scale ghost. The value stays off the
// page's scale because they said so, so the ring stops being drawn until they
// ask for the scale back (see the footer's `leave scale` / `use scale`).
const [leftScale, setLeftScale] = useState(false);
const wrapRef = useRef(null);
const dragRef = useRef(null);
// The hold timer and the last tap, for the tick-hold lock and the double-tap
// keypad. Refs rather than state: neither is rendered.
const holdRef = useRef(null);
const tapRef = useRef(null);
const writable = railWritable(prop, value);
// The range, and the step the drag uses: the user's chosen precision first, then
// the page's own step, then a fine/coarse pair that adapts to the value's size.
const range = writable.ok ? railRange(prop, value, Object.assign({ step: ctx.step }, ctx)) : null;
const info = classify(prop, value);
// The ladder this value's family offers: the precision segment, and the source
// of the drag's step when the page has no scale (see STEP_LADDER).
const ladder = stepLadder(range ? range.family : '');
const chosen = precision != null ? precision : (range && range.step ? range.step : null);
const step = chosen != null ? chosen : familyStep(info.number, range ? range.family : '');
const ticks = range ? railTicks(range, { step, tokens: ctx.tokens || [] }) : { minor: [], major: [], tokens: [] };
// The element's own box as targets (¼ / ½ / 1 of its size), which is the one
// snap source that knows how big *this* element is. Only a length gets them, and
// only when the sheet read a real size — see fractionSnaps.
const fractions = range ? fractionSnaps(range, ctx) : [];
// The durations a transition actually uses (100/150/200/300 ms). Dragging to an
// exact 150 ms on a 0…2000 ms rail is not a gesture a thumb can make, so for the
// time family these are one tap each — the mock's third time snap source.
const presets = range ? timePresets(range, ctx) : [];
const ratio = range ? valueToRatio(info.number, range) : 0;
// The off-scale ghost: the page's nearest on-scale value, drawn dashed and not
// draggable. `ctx.nearest` comes from the same snapValue reading the sheet's
// hint uses, so the ring and the hint can never disagree.
const ghost = (() => {
if (!range || ctx.nearest == null || leftScale) return null;
const n = Number(ctx.nearest);
if (!Number.isFinite(n)) return null;
if (n < range.min || n > range.max) return null;
return { number: n, ratio: valueToRatio(n, range) };
})();
// unitOptions gives the px ⇄ rem ⇄ % cycle, and it is the same control the type
// switch uses — so a rail-edited value and a switch-edited value end up in the
// same unit with the same base font size.
const units = unitOptions(prop, value, ctx);
// The conversion the footer prints beside the chips (`= 0.875rem`): read from
// the same option list, so it is always a conversion a chip would really write.
const equivalent = unitEquivalent(units);
// write — the one place a gesture reaches the field. `at` overrides the step for
// this write only, which is how a slow drag moves in the fine step without
// changing the precision the user chose.
function write(n, at) {
if (!range) return;
const size = Number.isFinite(at) && at > 0 ? at : null;
const clamped = size ? quantize(n, size, range) : quantize(n, null, range);
// The range is already expressed in the value's own unit — `railRange` converts
// a length's bounds through the page's real root font size for a rem value (see
// toUnit), so a drag writes rem against that root and not against a hard-coded
// 16. An unknown root leaves the bounds in px, and the write is px with them.
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
function moveTo(clientX, at) {
if (!range) return;
write(ratioToValue(ratioAt(clientX), range, at == null ? step : at), at);
}
function onDown(e) {
if (!range) return;
// Pointer capture is what makes this work without a drag library: the moves
// keep arriving after the finger leaves the 60 px track, and they stop when it
// lifts. `preventDefault` stops the sheet's scroller from stealing the gesture.
if (e.currentTarget.setPointerCapture) {
try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
}
// A new gesture releases a held tick: the lock is a statement about the value
// in force, and this gesture is about to change it.
if (lock) setLock(null);
const now = eventTime(e);
dragRef.current = { id: e.pointerId, moved: false, x: e.clientX, t: now, speed: null };
e.preventDefault();
moveTo(e.clientX, step);
}
// A drag changes step as it goes: a *slow* move means the user is aiming, so the
// value follows the family's finest step (the mock's "drag slowly for fine"), and
// a normal one keeps the coarse step that makes the gesture usable at all. The
// speed is smoothed, because a single pointer event's timing is noisy enough to
// flip the mode on every frame.
function onMove(e) {
const drag = dragRef.current;
if (!drag || drag.id !== e.pointerId) return;
const now = eventTime(e);
const dt = Math.max(1, now - drag.t);
const speed = Math.abs(e.clientX - drag.x) / dt;
drag.speed = drag.speed == null ? speed : drag.speed * 0.6 + speed * 0.4;
drag.x = e.clientX;
drag.t = now;
drag.moved = true;
e.preventDefault();
const use = dragStepFor(drag.speed, { family: range.family, step });
if (use.fine !== fine) setFine(use.fine);
moveTo(e.clientX, use.step);
}
function onUp(e) {
const drag = dragRef.current;
if (!drag) return;
dragRef.current = null;
if (fine) setFine(false);
if (e.currentTarget.releasePointerCapture) {
try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
}
// A tap (no movement) is the other half of the gesture set: one tap writes the
// value under the finger, and two in quick succession at the same place ask for
// the keypad — the value is close enough that typing it exactly is the next
// move, and the field is already on screen.
if (!drag.moved) {
const next = { at: eventTime(e), x: e.clientX };
if (isDoubleTap(tapRef.current, next)) {
tapRef.current = null;
if (props.onKeypad) props.onKeypad();
} else {
tapRef.current = next;
}
}
}
// eventTime — a pointer event's timestamp, with `performance.now()` as the
// fallback for an engine that does not carry one.
function eventTime(e) {
if (e && Number.isFinite(e.timeStamp) && e.timeStamp > 0) return e.timeStamp;
return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}
// Holding a tick locks to it (the mock's "tap-hold a tick locks to it"): the
// value is written, the tick is marked, and the header says what it is locked to
// until the next gesture releases it. A plain tap still just sets the value.
const clearHold = () => {
if (holdRef.current) {
clearTimeout(holdRef.current);
holdRef.current = null;
}
};
function holdTick(n, label) {
return {
onPointerDown: () => {
clearHold();
holdRef.current = setTimeout(() => {
holdRef.current = 'fired';
write(n);
setLock({ value: n, label: label });
}, HOLD_MS);
},
onPointerUp: clearHold,
onPointerCancel: clearHold,
onPointerLeave: clearHold
};
}
// Tapping the tick labels is the precise version of tapping the track: the label
// carries the exact number, so the value lands on it whatever the mapping does.
function tap(value) {
if (!range) return;
// A hold already wrote its value and set the lock; the click that follows it
// (a pointerup after a long press still fires one) must not undo that.
if (holdRef.current === 'fired') { holdRef.current = null; return; }
if (lock) setLock(null);
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
// The step in force, named for where it came from: the page's own scale when
// the index found one, the user's tapped precision when they chose one, and the
// family's own step otherwise (see STEP_LADDER). The two gestures that change
// it mid-flight say so here, because the thumb moving 1 px and then 4 px in one
// drag is otherwise indistinguishable from a bug.
lock
? 'locked · ' + lock.label
: fine
? 'fine ' + formatNumber(familyStep(0, range.family)) + (range.unit || '')
: step == null
? 'fine'
: precision != null
? formatNumber(precision) + (range.unit || '') + ' step'
: range.step
? 'page step ' + formatNumber(range.step) + (range.unit || '')
: 'step ' + formatNumber(step) + (range.unit || ''))
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
style: markStyle(valueToRatio(v, range), 2)
})),
ticks.major.map((v) => h('button', Object.assign({
class: 'inspector__rail-major' + (lock && lock.value === v ? ' is-locked' : ''),
type: 'button',
key: 'm' + v,
style: markStyle(valueToRatio(v, range), 2),
title: 'Set ' + prop + ' to ' + formatNumber(v) + (range.unit || '') + ' — hold to lock',
'aria-label': 'Set to ' + formatNumber(v) + (range.unit || ''),
onClick: () => tap(v)
}, holdTick(v, formatNumber(v) + (range.unit || ''))))),
ticks.tokens.map((t) => h('button', Object.assign({
class: 'inspector__rail-token' + (lock && lock.value === t.number ? ' is-locked' : ''),
type: 'button',
key: 'k' + t.name,
style: markStyle(t.ratio, 3),
title: t.name + ' = ' + t.value + ' — hold to lock',
'aria-label': 'Set to ' + t.name + ', which is ' + t.value,
onClick: () => tap(t.number)
}, holdTick(t.number, t.name)))),
ghost
? h('span', {
class: 'inspector__rail-ghost',
style: { left: pct(ghost.ratio) },
'aria-hidden': 'true'
})
: null,
// Box fractions — the third tick family. They sit between the round numbers and
// the tokens in a drag's vocabulary: not a page value, not a token, but "half of
// this element", which is a target a designer names out loud.
fractions.map((f) => h('button', Object.assign({
class: 'inspector__rail-frac' + (lock && lock.value === f.number ? ' is-locked' : ''),
type: 'button',
key: 'f' + f.fraction,
style: markStyle(f.ratio, 2),
title: f.label + ' of this element = ' + formatNumber(f.number) + (range.unit || '') + ' — hold to lock',
'aria-label': 'Set to ' + f.label + ' of this element, ' + formatNumber(f.number) + (range.unit || ''),
onClick: () => tap(f.number)
}, holdTick(f.number, f.label + ' of this element')))),
h('span', {
class: 'inspector__rail-thumb',
style: { left: pct(ratio) },
'aria-hidden': 'true'
}, info.number != null ? formatNumber(info.number) : '')
),
h('div', { class: 'inspector__rail-labels' },
ticks.major.map((v) => {
const r = valueToRatio(v, range);
// The edge labels align to the edge instead of centring on it: a label centred
// at 100% hangs half its width outside the rail, which is a horizontal overflow
// on every range whose last round number is its maximum.
const shift = r <= 0.0001 ? '0' : r >= 0.9999 ? '-100%' : '-50%';
return h('span', { key: 'l' + v, style: { left: pct(r), transform: 'translateX(' + shift + ')' } }, formatNumber(v));
}),
ticks.tokens.map((t) => h('span', { class: 'is-token', key: 'n' + t.name, style: { left: pct(t.ratio) } }, t.name),
fractions.map((f) => h('span', { class: 'is-fraction', key: 'fl' + f.fraction, style: { left: pct(f.ratio) } }, f.label)))
),
h('div', { class: 'inspector__rail-foot' },
h('div', { class: 'inspector__rail-seg', role: 'group', 'aria-label': 'Snap step' },
ladder.map((n) => h('button', {
class: 'inspector__rail-segbtn' + (step === n ? ' is-on' : ''),
type: 'button',
key: 'p' + n,
'aria-pressed': String(step === n),
title: 'Snap to ' + formatNumber(n) + (range.unit || '') + ' steps',
onClick: () => { setPrecision(n); if (range) write(quantize(info.number, n, range)); }
}, formatNumber(n) + ' ' + (range.unit || ''))),
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
// `= 0.875rem` — the unit chip cycles, so the footer says what the other unit
// is worth before the user spends a tap finding out. Rendered only when a chip
// in this row could actually make the change.
equivalent
? h('span', { class: 'inspector__rail-equiv' }, '= ' + equivalent)
: null,
presets.length
? h('div', { class: 'inspector__rail-presets', role: 'group', 'aria-label': 'Common durations' },
presets.map((p) => h('button', {
class: 'inspector__rail-presetchip' + (info.number === p.number ? ' is-on' : ''),
type: 'button',
key: 'd' + p.number,
'aria-pressed': String(info.number === p.number),
title: 'Set ' + prop + ' to ' + p.label,
onClick: () => write(p.number)
}, p.label))
)
: null,
// The other half of the mock's snap pair. The sheet's hint offers `Snap to 16px`
// for a value that is off the page's scale; this offers the opposite — keep the
// value as it is and stop judging it. Taking it switches the drag to the family's
// finest step and stops drawing the ghost, and `use scale` puts both back.
ctx.nearest != null && range.step
? h('button', {
class: 'inspector__rail-leave' + (leftScale ? ' is-on' : ''),
type: 'button',
'aria-pressed': String(leftScale),
title: leftScale
? 'Snap the drag back to the page\'s ' + formatNumber(range.step) + (range.unit || '') + ' step'
: 'Keep ' + value + ' — drag in ' + formatNumber(ladder[0]) + (range.unit || '') + ' steps instead of the page\'s ' + formatNumber(range.step) + (range.unit || ''),
onClick: () => {
if (leftScale) { setLeftScale(false); setPrecision(null); return; }
setLeftScale(true);
setPrecision(ladder[0]);
}
}, leftScale ? 'use scale' : 'leave scale')
: null,
ctx.scaleNote
? h('span', { class: 'inspector__rail-mini' }, ctx.scaleNote)
: null
)
);
}
export default ValueRail;
