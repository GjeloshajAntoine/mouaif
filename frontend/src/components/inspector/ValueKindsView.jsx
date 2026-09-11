// Inspector ValueKindsView — the per-kind views (Part R2).
//
// One rail is the right changer for *a* number. It is the wrong control for a
// colour (three numbers that only mean something together), for a four-sided
// shorthand (four numbers that are one declaration), for a function list (an
// ordered list of rail-shaped arguments) and for an enum (not a number at all).
// This component renders the view each kind asks for, in the K2–K4 shape:
//
//   colour   three rails (hue / saturation / lightness), the page's palette as
//            swatches with contrast badges, and hex / rgb / hsl format chips;
//   fanout   one sub-rail per side with a "link all sides" toggle, written back
//            as the shortest valid shorthand (joinSides; the full round-trip
//            guarantees land in R3);
//   enum     segmented keyword chips, the page's own values first;
//   functions one rail per argument for a function list, or one row per item for
//            a comma list (box-shadow, transition);
//   image    the page's own images and gradients as candidates, no rail;
//   text     the typed field only, with the reason stated.
//
// Every write here still goes through the caller's `onChange`, which only
// rewrites the sheet's value field: Apply remains the single commit point, so
// every kind's edit is one property and one undo entry.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import {
valueShape, sidesFor, splitSides, joinSides, functionList, joinFunctions,
listItems, joinListItems, enumValues, parseColourParts, joinColourParts,
colourRailValues, applyRailPart, timeOptions, angleOptions, imageCandidates,
contrastForValue
} from './valueShapes.js';
import { railRange, valueToRatio, ratioToValue, quantize, tickValues } from './valueRail.js';
import { formatNumber } from './valueKinds.js';
// SubRail — the short rail the fan-out and function rows use. It is the same
// math as the main rail (valueToRatio / ratioToValue / quantize) with a compact
// presentation: name, track, thumb, value. No ticks and no footer, because four
// of them stacked is already a lot of a 360 px sheet.
function SubRail(props) {
const range = props.range;
const step = props.step;
const value = Number(props.value);
const ratio = Number.isFinite(value) ? valueToRatio(value, range) : 0;
const move = (clientX, el) => {
if (!range || !el) return;
const rect = el.getBoundingClientRect();
if (!(rect.width > 0)) return;
const r = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
props.onChange(ratioToValue(r, range, step));
};
return h('div', { class: 'inspector__subrail' },
h('span', { class: 'inspector__subrail-name' }, props.label),
h('div', {
class: 'inspector__subrail-track',
role: 'slider',
tabIndex: 0,
'aria-label': props.label + ' value',
'aria-valuemin': String(range ? range.min : ''),
'aria-valuemax': String(range ? range.max : ''),
'aria-valuenow': Number.isFinite(value) ? String(value) : '',
onPointerDown: (e) => {
const el = e.currentTarget;
if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ } }
e.preventDefault();
move(e.clientX, el);
},
onPointerMove: (e) => {
if (!e.currentTarget.hasPointerCapture || e.currentTarget.hasPointerCapture(e.pointerId)) {
if (e.buttons || e.pointerType === 'touch') move(e.clientX, e.currentTarget);
}
},
onKeyDown: (e) => {
if (!range) return;
if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); props.onChange(quantize(value + step, step, range)); }
if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); props.onChange(quantize(value - step, step, range)); }
}
},
h('span', { class: 'inspector__subrail-fill', style: { width: (ratio * 100).toFixed(2) + '%' } }),
h('span', { class: 'inspector__subrail-thumb', style: { left: (ratio * 100).toFixed(2) + '%' } })
),
h('span', { class: 'inspector__subrail-value' }, props.text)
);
}
// ColourView — K2. Three rails, the page's palette, the format chips.
//
// The rails are HSL rather than RGB because that is how a designer thinks about
// a colour, and because the hue rail can be a *picture* of the gamut: the track
// is the real gradient at the current saturation and lightness.
function ColourView(props) {
const parts = parseColourParts(props.value);
if (!parts || parts.format === 'unknown') {
return h('p', { class: 'inspector__shape-note' },
parts && parts.keyword === 'currentcolor'
? 'currentcolor follows the element’s text colour — set it from the color row instead.'
: 'No colour view: this value is not a colour the inspector can read, so the typed field is the control.'
);
}
const rails = colourRailValues(parts);
const formats = ['hex', 'rgb', 'hsl'];
// MAX_PALETTE — colour candidates get a swatch, a value and a ratio badge, which
// is three times the width of a plain chip; five is what fits the sheet without
// turning the palette into a wall. The Suggestions row above renders no colour
// group at all while this view is up, so the palette is shown once.
const MAX_PALETTE = 5;
const palette = (props.candidates || []).slice(0, MAX_PALETTE).map((c) => Object.assign({}, c, {
contrast: contrastForValue(c.value, props.background, props.contrastCtx)
}));
return h('div', { class: 'inspector__shape inspector__shape--colour' },
rails.map((rail) => {
const ratio = rail.key === 'h' ? rail.value / 360 : rail.value / 100;
const set = (clientX, el) => {
if (!el) return;
const rect = el.getBoundingClientRect();
if (!(rect.width > 0)) return;
const r = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
const next = applyRailPart(parts, rail.key, rail.key === 'h' ? r * 360 : r * 100);
props.onChange(joinColourParts(next, props.format || parts.format));
};
return h('div', { class: 'inspector__railcard', key: rail.key },
h('div', { class: 'inspector__railhead' },
h('span', { class: 'inspector__rail-kind' }, rail.label),
h('span', { class: 'inspector__rail-now' }, rail.value + rail.suffix),
h('span', { class: 'inspector__rail-ev' }, rail.end)
),
h('div', {
class: 'inspector__railwrap inspector__railwrap--short',
role: 'slider',
tabIndex: 0,
'aria-label': rail.label,
'aria-valuemin': '0',
'aria-valuemax': String(rail.max),
'aria-valuenow': String(rail.value),
'aria-valuetext': rail.value + rail.suffix,
onPointerDown: (e) => {
const el = e.currentTarget;
if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ } }
e.preventDefault();
set(e.clientX, el);
},
onPointerMove: (e) => {
if (!e.currentTarget.hasPointerCapture || e.currentTarget.hasPointerCapture(e.pointerId)) {
if (e.buttons || e.pointerType === 'touch') set(e.clientX, e.currentTarget);
}
},
onKeyDown: (e) => {
if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
e.preventDefault();
const d = e.key === 'ArrowRight' ? 1 : -1;
const nextVal = rail.value + d * (rail.key === 'h' ? 1 : 1);
props.onChange(joinColourParts(applyRailPart(parts, rail.key, nextVal), props.format || parts.format));
}
},
h('span', { class: 'inspector__rtrack', style: { background: rail.track } }),
h('span', { class: 'inspector__rtrack-fill', style: { width: (ratio * 100).toFixed(2) + '%' } }),
h('span', { class: 'inspector__rthumb', style: { left: (ratio * 100).toFixed(2) + '%', background: rail.now } })
)
);
}),
h('div', { class: 'inspector__shape-row', role: 'group', 'aria-label': 'Colour format' },
formats.map((f) => h('button', {
class: 'inspector__shape-chip' + ((props.format || parts.format) === f ? ' is-on' : ''),
type: 'button',
key: f,
'aria-pressed': String((props.format || parts.format) === f),
onClick: () => props.onFormat(f)
}, f))
),
palette.length
? h('div', { class: 'grp' },
h('div', { class: 'gh' }, 'This page\'s palette', h('span', null, ' · contrast vs this element')),
h('div', { class: 'opts' },
palette.map((c) => h('button', {
class: 'opt inspector__suggest-colour'
+ (c.isCurrent ? ' is-current' : '')
+ (c.contrast && c.contrast.okLevel ? '' : ' is-unreadable'),
type: 'button',
key: 'c-' + c.value,
title: c.value + (c.contrast && c.contrast.text ? ' · ' + c.contrast.text : ''),
'aria-label': 'Use ' + c.value + (c.contrast && c.contrast.text ? ', contrast ' + c.contrast.text : ''),
onClick: () => props.onChange(c.value)
},
h('span', { class: 'inspector__suggest-sw', style: { background: c.value }, 'aria-hidden': 'true' }),
h('span', { class: 'inspector__suggest-value' }, c.value),
c.contrast && c.contrast.text
? h('span', { class: 'inspector__suggest-aa' + (c.contrast.okLevel ? '' : ' is-bad') }, c.contrast.text)
: null
))
)
)
: null
);
}
// FanoutView — K3. One sub-rail per side, a "link all sides" toggle, and the
// value line that round-trips back to the shorthand.
function FanoutView(props) {
const def = sidesFor(props.prop);
const split = splitSides(props.prop, props.value);
const [linked, setLinked] = useState(null);
if (!def || !split.ok) {
return h('p', { class: 'inspector__shape-note' },
'No fan-out view: ' + ((split && split.reason) || 'this property has no sides') + '. The typed field is the control.'
);
}
// "Link all" starts on for a shorthand that is already uniform, because that is
// the state the user is in — starting it off for `10px` would make the first
// drag surprising.
const isLinked = linked == null ? split.uniform : linked;
const unit = split.unit || 'px';
const setSide = (key, n) => {
const sides = Object.assign({}, split.sides);
if (isLinked) {
for (const s of def) sides[s.key] = formatNumber(n) + unit;
} else {
sides[key] = formatNumber(n) + unit;
}
props.onChange(joinSides(props.prop, sides));
};
return h('div', { class: 'inspector__shape inspector__shape--fanout' },
h('div', { class: 'inspector__linkrow' },
h('button', {
class: 'inspector__linktog' + (isLinked ? ' is-on' : ''),
type: 'button',
role: 'switch',
'aria-checked': String(isLinked),
'aria-label': 'Link all sides',
onClick: () => setLinked(!isLinked)
}, h('span', { class: 'inspector__linktog-knob', 'aria-hidden': 'true' })),
h('span', null, 'Link all sides — drag one, all move')
),
h('div', { class: 'inspector__railcard' },
def.map((s) => {
const n = split.numbers[s.key];
const range = railRange(props.prop, (n == null ? 0 : n) + unit, props.ctx || {});
return h('div', { key: s.key, class: 'inspector__subrail-row' },
h(SubRail, {
label: s.label,
value: n == null ? 0 : n,
range,
step: props.step || 1,
text: split.sides[s.key],
onChange: (v) => setSide(s.key, v)
})
);
})
),
h('p', { class: 'inspector__shape-line' }, props.prop + ': ' + joinSides(props.prop, split.sides)),
h('p', { class: 'inspector__shape-note' },
'Written back as the shortest valid shorthand; every side is one declaration and one undo.'
)
);
}
// EnumView — K4's enum. Segments, the page's own values first.
function EnumView(props) {
const values = enumValues(props.prop, props.used || []);
const current = String(props.value || '').trim().toLowerCase();
return h('div', { class: 'inspector__shape inspector__shape--enum' },
h('div', { class: 'inspector__opts', role: 'group', 'aria-label': props.prop + ' keyword' },
values.map((v) => h('button', {
class: 'inspector__shape-chip'
+ (v.key === current ? ' is-on' : '')
+ (v.source === 'page' ? ' is-page' : '')
+ (v.wide ? ' is-wide' : ''),
type: 'button',
key: v.key,
'aria-pressed': String(v.key === current),
title: v.source === 'page' ? v.value + ' — used on this page' : v.value + (v.wide ? ' — a CSS-wide keyword' : ''),
onClick: () => props.onChange(v.value)
}, v.value))
),
h('p', { class: 'inspector__shape-note' },
props.used && props.used.length
? 'The page\'s own values come first; the CSS-wide keywords are last.'
: 'The property\'s own keywords; the CSS-wide keywords are last.'
)
);
}
// FunctionsView — one rail per argument (functions) or one row per item (a
// comma list such as box-shadow or transition).
function FunctionsView(props) {
const list = functionList(props.value);
if (list) {
const setArg = (fi, ai, next) => {
const copy = list.map((f) => ({ name: f.name, args: f.args.map((a) => ({ raw: a.raw, value: a.value })) }));
copy[fi].args[ai].value = next;
props.onChange(joinFunctions(copy));
};
const remove = (fi) => {
const copy = list.filter((f, i) => i !== fi);
props.onChange(copy.length ? joinFunctions(copy) : 'none');
};
return h('div', { class: 'inspector__shape inspector__shape--functions' },
list.map((f) => h('div', { class: 'inspector__railcard', key: f.name + f.index },
h('div', { class: 'inspector__railhead' },
h('span', { class: 'inspector__rail-kind' }, f.name),
h('span', { class: 'inspector__rail-ev' }, f.args.length + (f.args.length === 1 ? ' argument' : ' arguments')),
list.length > 1
? h('button', {
class: 'inspector__fn-remove',
type: 'button',
'aria-label': 'Remove ' + f.name,
onClick: () => remove(f.index)
}, '✕')
: null
),
f.args.map((a, ai) => h('div', { key: 'a' + ai, class: 'inspector__subrail-row' },
h(SubRail, {
label: 'arg ' + (ai + 1),
value: Number(String(a.value).replace(/[^\d.+-]/g, '')),
range: railRange(props.prop, a.value, props.ctx || {}),
step: argStep(a.value, props.step),
text: a.value,
onChange: (v) => setArg(f.index, ai, formatNumber(v) + argUnit(a.value))
})
))
))
);
}
const items = listItems(props.prop, props.value);
if (items) {
const setItem = (ii, ai, next) => {
const copy = items.map((it) => ({ index: it.index, raw: it.raw, args: it.args.map((a) => ({ raw: a.raw, value: a.value })) }));
copy[ii].args[ai].value = next;
props.onChange(joinListItems(copy));
};
return h('div', { class: 'inspector__shape inspector__shape--list' },
items.map((it, ii) => h('div', { class: 'inspector__railcard', key: 'i' + ii },
h('div', { class: 'inspector__railhead' },
h('span', { class: 'inspector__rail-kind' }, props.prop + ' #' + (ii + 1)),
h('span', { class: 'inspector__rail-ev' }, it.args.length + ' values')
),
it.args.map((a, ai) => h('div', { key: 'a' + ai, class: 'inspector__subrail-row' },
h(SubRail, {
label: String(a.value).slice(0, 8),
value: Number(String(a.value).replace(/[^\d.+-]/g, '')),
range: railRange(props.prop, a.value, props.ctx || {}),
step: argStep(a.value, props.step),
text: a.value,
onChange: (v) => setItem(ii, ai, formatNumber(v) + argUnit(a.value))
})
))
))
);
}
return h('p', { class: 'inspector__shape-note' },
'No per-argument view: this value is not a list the inspector can take apart, so the typed field is the control.'
);
}
// argUnit / argStep — the unit an argument carries (so a rail writes it back) and
// the step to move it by. An argument with no unit (`scale(1.02)`) keeps none.
function argUnit(raw) {
const m = /([a-z%]+)$/i.exec(String(raw || '').trim());
return m ? m[1] : '';
}
function argStep(raw, pageStep) {
return pageStep || 1;
}
// TimeView / AngleView — the K4 rows. The rail is the main changer; these add
// the unit segment the kind needs.
function UnitRow(props) {
const options = props.options || [];
if (options.length < 2) return null;
return h('div', { class: 'inspector__shape-row', role: 'group', 'aria-label': props.label },
options.map((o) => h('button', {
class: 'inspector__shape-chip' + (o.current ? ' is-on' : ''),
type: 'button',
key: o.unit,
'aria-pressed': String(!!o.current),
onClick: () => props.onChange(o.value)
}, o.unit))
);
}
// ImageView — no rail; the page's own images and gradients, offered instead.
function ImageView(props) {
const candidates = imageCandidates(props.candidates || []);
if (!candidates.length) {
return h('p', { class: 'inspector__shape-note' },
'No rail for an image: the page declares no other images or gradients for this property, so the typed field is the control.'
);
}
return h('div', { class: 'inspector__shape inspector__shape--image' },
h('div', { class: 'grp' },
h('div', { class: 'gh' }, 'On this page', h('span', null, ' · images and gradients')),
h('div', { class: 'opts' },
candidates.map((c) => h('button', {
class: 'opt' + (c.value === String(props.value || '').trim() ? ' is-current' : ''),
type: 'button',
key: c.value,
title: c.value,
'aria-label': 'Use ' + c.value,
onClick: () => props.onChange(c.value)
},
c.thumb
? h('span', { class: 'inspector__shape-thumb', style: { backgroundImage: c.value }, 'aria-hidden': 'true' })
: null,
h('span', { class: 'inspector__suggest-value' }, c.value)
))
)
),
h('p', { class: 'inspector__shape-note' },
'No rail — an image is not a number. The page\'s own candidates are offered instead.'
)
);
}
// ValueKindsView — the one entry point. It picks the view by shape and renders
// nothing for 'rail' (the main rail owns that) or for a shape the caller wants
// handled in the value row.
export function ValueKindsView(props) {
// The view the sheet opened with. A fan-out can legitimately collapse to a
// single value while it is open (drag one side with "link all" on) and the view
// must not vanish under the user's finger, so the sheet passes the shape it
// started with and that is kept for as long as the property does not change.
const shape = valueShape(props.prop, props.value, props.sticky);
if (shape === 'rail') return null;
if (shape === 'text') {
// The honest fallback: the typed field is the control, and the line says why.
return h('p', { class: 'inspector__shape-note' },
'No shape view for this value — the typed field is the control.'
);
}
if (shape === 'colour') return h(ColourView, props);
if (shape === 'fanout') return h(FanoutView, props);
if (shape === 'enum') return h(EnumView, props);
if (shape === 'functions') return h(FunctionsView, props);
if (shape === 'image') return h(ImageView, props);
if (shape === 'time') {
return h('div', { class: 'inspector__shape' },
h(UnitRow, { label: 'Time unit', options: timeOptions(props.value), onChange: props.onChange })
);
}
if (shape === 'angle') {
return h('div', { class: 'inspector__shape' },
h(UnitRow, { label: 'Angle unit', options: angleOptions(props.value), onChange: props.onChange })
);
}
return null;
}
export default ValueKindsView;
