// Inspector StylesPanel — the touch-first style surface.
//
// This is the UI half of the surface described in styleControls.js: one card per
// control, each card a finger-sized widget instead of a property/value text row.
// The images it follows answer "how do you change a style on a phone?" with
// segmented chips, a slider with − / + steppers, a box model you can tap an edge
// of, and swatches — because none of those need a keyboard, and every one of them
// shows the value it will write before it writes it.
//
// The rules this component holds itself to:
//
//   - **44 px minimum, always.** Every segment, stepper, chip, edge and swatch is
//     at least `--tap` tall/wide (see inspector-touch.css). A control that looks
//     tappable and is not is the bug this whole surface exists to avoid.
//   - **One write per gesture.** A slider updates a local draft on `input` and
//     writes once on `change` (release); a chip or stepper writes on tap. The
//     panel's apply path records one receipt entry and one undo per write, so a
//     drag is one undoable change rather than sixty.
//   - **The keyboard is always one tap away.** Every numeric row's value is a
//     button that opens the existing edit sheet — the sheet is where exact typing,
//     the value-type switch, the unit row and the page's own value suggestions
//     live, and no touch control replaces it.
//   - **Grouped, not infinite.** Six wrapped tab chips switch between Layout,
//     Spacing, Size, Text, Colour and Effects, so a phone shows a handful of rows
//     at a time instead of the wall of a desktop Styles pane.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import {
GROUPS, SIDE_LABEL, controlsFor, defaultGroup, readValue, isDeclared,
parseNumber, specForValue, stepChoices, percentFor, valueAtPercent, nudgeValue, unitChoices,
segmentOptions, boxEdges, toUnit, unitFor, classifyControl
} from './styleControls.js';

// useDraft — the local value a control previews while a finger is down. Cleared
// whenever the page's own value changes (which is what a commit produces), so a
// draft can never outlive the write it was previewing.
function useDraft(value) {
const [draft, setDraft] = useState(null);
useEffect(() => { setDraft(null); }, [value]);
return [draft == null ? value : draft, setDraft];
}

// RowHead — the label line every control shares: what the control edits, the CSS
// property it writes (so the surface teaches the property name rather than hiding
// it), and the value as a button into the exact editor.
function RowHead(props) {
return h('div', { class: 'inspector__touch-head' },
h('span', { class: 'inspector__touch-label' },
h('span', { class: 'inspector__touch-name' }, props.label),
h('code', { class: 'inspector__touch-prop' }, props.prop),
props.isSet ? h('span', { class: 'inspector__touch-set', title: 'Declared on this element' }, 'set') : null
),
h('button', {
class: 'inspector__touch-value' + (props.isSet ? ' is-set' : ''),
type: 'button',
disabled: props.disabled,
title: props.value
? 'Type an exact value for ' + props.prop + ' (now ' + props.value + ')'
: 'Type a value for ' + props.prop,
'aria-label': 'Edit ' + props.prop + (props.value ? ', now ' + props.value : '') + ' in the value editor',
onClick: () => props.onEdit(props.prop, props.value)
}, props.value || '—')
);
}

// StepButtons — the − / + pair that flank every slider. Stepping is the fastest
// way to size something one-handed, and it is also the only way to move a value
// the slider cannot reach: the drag covers the span, the steps walk it. A value
// the row cannot move (`auto`, `calc(...)`) disables both and the row says why.
function StepButtons(props) {
return [
h('button', {
class: 'inspector__touch-step',
type: 'button',
key: 'down',
disabled: props.disabled || !props.down,
title: props.down ? 'Decrease ' + props.prop + ' to ' + props.down.css : 'Not a number — use the value editor',
'aria-label': 'Decrease ' + props.prop,
onClick: () => props.onStep(props.down)
}, '−'),
h('button', {
class: 'inspector__touch-step',
type: 'button',
key: 'up',
disabled: props.disabled || !props.up,
title: props.up ? 'Increase ' + props.prop + ' to ' + props.up.css : 'Not a number — use the value editor',
'aria-label': 'Increase ' + props.prop,
onClick: () => props.onStep(props.up)
}, '+')
];
}

// SliderRow — one numeric property: a 44 px value button, a − / + pair, a range
// input and the row's footer (unit chips and the Fine / Coarse switch).
//
// The range is a native `input[type=range]`, deliberately: it is the one control
// a phone already knows how to drag, it is keyboard- and screen-reader-complete
// for free, and it does not need custom pointer arithmetic that would have to be
// re-tested for every gesture. Its 44 px hit area comes from the CSS.
//
// `ctx` is the element's own values (what `isDeclared` reads) and `unitCtx` is the
// base font sizes the unit chips convert with — two different questions that
// happen to travel in two objects the panel already has.
function SliderRow(props) {
const { prop, label, value, ctx, unitCtx, spec, onApply, onEdit, disabled, note, keywords } = props;
const [fine, setFine] = useState(false);
const [draft, setDraft] = useDraft(value);
const span = spec || specForValue(prop, value);
const steps = stepChoices(span);
const step = fine ? steps.fine : steps.coarse;
const parsed = parseNumber(value);
const unit = unitFor(prop, value, span);
const ratio = parsed ? percentFor(value, span) : 0;
const shown = draft == null ? value : draft;
const down = nudgeValue(value, -1, span, step);
const up = nudgeValue(value, 1, span, step);
const units = unitChoices(prop, value, unitCtx);
const writable = !!parsed;
// The slider's own resolution: the row's step expressed as a percentage of the
// span, so a Fine drag moves the thumb by a fraction of a percent instead of
// lumping to whole percent.
const rangeStep = Math.max(0.1, (step / (span.max - span.min)) * 100);
function css(pct) {
return toUnit(valueAtPercent(pct, span, step), prop, unit, unitCtx);
}
function commitPct(pct) {
const next = css(pct);
if (String(next) === String(value)) return;
onApply(prop, next);
}
return h('div', { class: 'inspector__touch-row' },
h(RowHead, {
label, prop, value, isSet: isDeclared(prop, ctx), disabled, onEdit
}),
note ? h('p', { class: 'inspector__touch-note' }, note) : null,
h('div', { class: 'inspector__touch-range' },
StepButtons({
prop, down, up, disabled: disabled || !writable,
onStep: (n) => { if (n) onApply(prop, n.css); }
}),
h('input', {
class: 'inspector__touch-slider',
type: 'range',
min: 0,
max: 100,
step: rangeStep,
value: String(Math.round(ratio * 1000) / 10),
disabled: disabled || !writable,
'aria-label': label + ' (' + prop + ')',
'aria-valuetext': shown,
onInput: (e) => setDraft(css(Number(e.currentTarget.value) / 100)),
onChange: (e) => { setDraft(null); commitPct(Number(e.currentTarget.value) / 100); }
}),
h('span', { class: 'inspector__touch-readout', 'aria-hidden': 'true' }, shown || '—')
),
writable
? h('div', { class: 'inspector__touch-foot' },
units.length > 1
? h('div', { class: 'inspector__touch-chips', role: 'group', 'aria-label': 'Unit for ' + prop },
units.map((u) => h('button', {
class: 'inspector__touch-chip' + (u.current ? ' is-on' : ''),
type: 'button',
key: u.unit,
disabled: !u.ok || u.current || disabled,
'aria-pressed': String(!!u.current),
title: u.title,
onClick: () => onApply(prop, u.value)
}, u.unit))
)
: null,
h('div', { class: 'inspector__touch-chips', role: 'group', 'aria-label': 'Step size for ' + prop },
h('button', {
class: 'inspector__touch-chip' + (fine ? '' : ' is-on'),
type: 'button',
'aria-pressed': String(!fine),
title: 'Step by ' + steps.coarse + ' — the design scale',
onClick: () => setFine(false)
}, 'Coarse'),
h('button', {
class: 'inspector__touch-chip' + (fine ? ' is-on' : ''),
type: 'button',
'aria-pressed': String(fine),
title: 'Step by ' + steps.fine + ' — a fraction of the coarse step',
onClick: () => setFine(true)
}, 'Fine')
)
)
: h('p', { class: 'inspector__touch-note' }, 'Not a number (' + (value || 'unset') + ') — the value editor can rewrite it.'),
keywords && keywords.length
? h('div', { class: 'inspector__touch-chips', role: 'group', 'aria-label': 'Common values for ' + prop },
keywords.map((k) => h('button', {
class: 'inspector__touch-chip' + (String(value).toLowerCase() === k.value ? ' is-on' : ''),
type: 'button',
key: k.value,
'aria-pressed': String(String(value).toLowerCase() === k.value),
disabled: disabled,
title: 'Set ' + prop + ' to ' + k.value,
onClick: () => onApply(prop, k.value)
}, k.label))
)
: null
);
}

// SegmentsRow — an enumerated property as chips. This is the control the images
// lean on hardest: `display`, `align-items`, `justify-content` and `text-align`
// are four to six named possibilities each, and a chip that names the possibility
// beats a text field that requires recalling the keyword. An element whose value
// the list does not name (`display: table`) gets that value as one extra chip, so
// the row still answers "what is it now?".
function SegmentsRow(props) {
const { control, value, ctx, onApply, onEdit, disabled } = props;
const rows = segmentOptions(control, value);
return h('div', { class: 'inspector__touch-row' },
h(RowHead, {
label: control.label, prop: control.prop, value, isSet: isDeclared(control.prop, ctx), disabled, onEdit
}),
h('div', { class: 'inspector__touch-seg', role: 'group', 'aria-label': control.label + ' (' + control.prop + ')' },
rows.map((o) => h('button', {
class: 'inspector__touch-segbtn' + (o.isOn ? ' is-on' : '') + (o.unknown ? ' is-unknown' : ''),
type: 'button',
key: o.value,
'aria-pressed': String(!!o.isOn),
disabled: disabled || !!o.isOn || !!o.unknown,
title: o.title,
onClick: () => onApply(control.prop, o.value)
},
h('span', { class: 'inspector__touch-segglyph', 'aria-hidden': 'true' }, o.glyph),
h('span', { class: 'inspector__touch-seglabel' }, o.label)
))
),
control.hint ? h('p', { class: 'inspector__touch-note' }, control.hint) : null
);
}

// ColourRow — a colour property as a swatch plus the page's own colours. The
// swatch and the value both open the edit sheet, where the colour view has the
// rails and the palette with contrast ratios; the chips here are the one-tap
// path, drawn from the values the page already uses (`valuesFor`), which is what
// makes "use the same green as the rest of the page" a tap instead of a hex hunt.
function ColourRow(props) {
const { control, value, ctx, onApply, onEdit, disabled, swatches } = props;
const rows = (swatches || []).filter((v) => v && String(v).toLowerCase() !== String(value || '').toLowerCase());
return h('div', { class: 'inspector__touch-row' },
h(RowHead, {
label: control.label, prop: control.prop, value, isSet: isDeclared(control.prop, ctx), disabled, onEdit
}),
h('div', { class: 'inspector__touch-colour' },
h('button', {
class: 'inspector__touch-stroke',
type: 'button',
style: { background: value || 'transparent' },
disabled,
title: value ? 'Edit ' + control.prop + ' (' + value + ')' : 'Pick a colour for ' + control.prop,
'aria-label': 'Edit ' + control.prop + (value ? ', now ' + value : ''),
onClick: () => onEdit(control.prop, value)
}),
rows.length
? h('div', { class: 'inspector__touch-chips', role: 'group', 'aria-label': 'Colours this page uses for ' + control.prop },
rows.map((v) => h('button', {
class: 'inspector__touch-swatch',
type: 'button',
key: v,
style: { background: v },
disabled,
title: 'Set ' + control.prop + ' to ' + v,
'aria-label': 'Set ' + control.prop + ' to ' + v,
onClick: () => onApply(control.prop, v)
}))
)
: null
),
control.hint ? h('p', { class: 'inspector__touch-note' }, control.hint) : null
);
}

// BoxRing — one ring of the box model: four edge buttons on a 3x3 grid whose
// middle cell holds whatever is inside this ring (`children`, or the ring's name).
function BoxRing(props) {
const { box, edges, selected, onSelect, style, children } = props;
return h('div', { class: 'inspector__touch-box inspector__touch-box--' + box, style },
edges.filter((e) => e.box === box).map((e) => h('button', {
class: 'inspector__touch-edge'
+ (selected.box === e.box && selected.side === e.side ? ' is-on' : '')
+ (e.isSet ? ' is-set' : ''),
type: 'button',
key: e.prop,
style: { gridArea: e.side },
'aria-pressed': String(selected.box === e.box && selected.side === e.side),
title: e.value
? e.prop + ' is ' + e.value + ' — tap to edit it in the row below'
: e.prop + ' is not set — tap to edit it in the row below',
'aria-label': e.prop + (e.value ? ', ' + e.value : ', not set'),
onClick: () => onSelect(e)
}, e.value || '—')),
h('div', { class: 'inspector__touch-boxmid', style: { gridArea: 'mid' } },
children || h('span', { class: 'inspector__touch-boxname', 'aria-hidden': 'true' }, box))
);
}

// BoxModel — the spacing editor: an outer ring for the margin and an inner one
// for the padding, four tappable edges each, with the element's own label in the
// middle. Tapping an edge selects it and the slider underneath becomes that
// edge's, so the box answers "where is the space?" and the slider answers "how
// much?" — the split the spacing step in the images makes.
function BoxModel(props) {
const { edges, selected, onSelect, label, ctx, unitCtx, onApply, onEdit, disabled } = props;
const sel = edges.find((e) => e.box === selected.box && e.side === selected.side) || edges[0];
return h('div', { class: 'inspector__touch-row' },
h('div', { class: 'inspector__touch-head' },
h('span', { class: 'inspector__touch-label' },
h('span', { class: 'inspector__touch-name' }, 'Box model'),
h('code', { class: 'inspector__touch-prop' }, 'margin · padding')
)
),
h('div', { class: 'inspector__touch-boxes' },
h(BoxRing, { box: 'margin', edges, selected, onSelect },
h(BoxRing, { box: 'padding', edges, selected, onSelect },
h('span', { class: 'inspector__touch-boxtag' }, label || 'content')))
),
h('p', { class: 'inspector__touch-note' },
'Editing ' + sel.prop + (sel.isSet
? ' — declared on this element'
: ' — currently from a rule, so an edit copies it onto the element')
),
h(SliderRow, {
prop: sel.prop,
label: SIDE_LABEL[sel.side] + ' ' + sel.box,
value: sel.value,
ctx,
unitCtx,
onApply,
onEdit,
disabled
})
);
}

// StyleControls — the surface itself: the group chips, the rows of the group in
// force, and the primary "Add property" button that opens the card sheet.
//
// `key` is passed by the panel as the element's objectId, so a new selection
// remounts the surface and the group resets to what the new element needs
// (`defaultGroup`: Layout for a flex container, Spacing otherwise).
export function StyleControls(props) {
const { ctx, unitCtx, onApply, onEdit, onAddProperty, disabled, swatchesFor, label } = props;
const [group, setGroup] = useState(() => defaultGroup(ctx));
const [selected, setSelected] = useState({ box: 'padding', side: 'top' });
const edges = boxEdges(ctx);
const controls = controlsFor(group, ctx);
// A group's chip carries a dot when the element declares a property in it: on a
// phone the tabs are the only index of the surface, so "where is the thing I set
// last time?" has to be answerable without opening all six.
function groupHasSet(id) {
return controlsFor(id, ctx).some((c) => (c.kind === 'box'
? edges.some((e) => e.isSet)
: isDeclared(c.prop, ctx)));
}
return h('div', { class: 'inspector__touch' },
h('div', { class: 'inspector__touch-tabs', role: 'group', 'aria-label': 'Style groups' },
GROUPS.map((g) => h('button', {
class: 'inspector__touch-tab' + (group === g.id ? ' is-on' : '') + (groupHasSet(g.id) ? ' is-set' : ''),
type: 'button',
key: g.id,
'aria-pressed': String(group === g.id),
title: g.label + ' styles' + (groupHasSet(g.id) ? ' — something here is set on this element' : ''),
onClick: () => setGroup(g.id)
}, g.label))
),
controls.length
? controls.map((c) => {
const value = readValue(c.prop, ctx);
if (c.kind === 'box') {
return h(BoxModel, {
key: c.id,
edges,
selected,
onSelect: (e) => setSelected({ box: e.box, side: e.side }),
label,
ctx,
unitCtx,
onApply,
onEdit,
disabled
});
}
if (c.kind === 'segments') {
return h(SegmentsRow, { key: c.id, control: c, value, ctx, onApply, onEdit, disabled });
}
if (c.kind === 'colour') {
return h(ColourRow, {
key: c.id,
control: c,
value,
ctx,
swatches: swatchesFor ? swatchesFor(c.prop) : [],
onApply,
onEdit,
disabled
});
}
// A slider whose value the style family cannot classify (a `var(--x)` or a
// keyword) still renders — the row then says so and offers the value editor,
// which is more honest than hiding the property the user is looking for.
return h(SliderRow, {
key: c.id,
prop: c.prop,
label: c.label,
spec: specForValue(c.prop, value),
keywords: c.keywords,
note: c.hint,
kind: classifyControl(c.prop, value).kind,
value,
ctx,
unitCtx,
onApply,
onEdit,
disabled
});
})
: h('p', { class: 'inspector__touch-none' }, 'No controls in this group for this element.'),
h('button', {
class: 'inspector__touch-add',
type: 'button',
disabled,
title: 'Browse CSS properties and add one to this element',
onClick: onAddProperty
},
h('span', { class: 'inspector__touch-addglyph', 'aria-hidden': 'true' }, '＋'),
h('span', null, 'Add property')
),
h('p', { class: 'inspector__touch-footnote' },
'Every control writes the element\'s own inline style — one property per tap, and the receipt below can undo it.'
)
);
}
