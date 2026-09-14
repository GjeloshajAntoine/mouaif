// Inspector StylesPanel — tap to select an element, then edit its CSS.
//
// A mobile-first, touch-friendly alternative to the desktop DevTools
// "Styles" pane. Instead of a deep DOM tree + a long style origin list,
// the user taps (or types a selector for) an element, and the panel
// presents:
//
//   1. The element label (tag#id.class) plus a box-model size summary.
//   2. A "declared" section — the element's own inline styles,
//      rendered as a plain list of property → value rows the user can
//      tap to edit. Editing writes straight to the element's inline
//      style (Runtime.callFunctionOn / CSSOM setProperty), which is
//      what the desktop Styles pane does for the "element.style"
//      origin — no stylesheet parsing, no selector resolution.
//   3. A "computed" section — the resolved values (CSS
//      getComputedStyleForNode), read-only, so the user can confirm an
//      edit took effect even when a class or external rule overrides it.
//
// Editing is deliberately inline-style-only. Changing a stylesheet rule
// (the "matched rules" origins) needs a style sheet source to parse and
// a matching CSS.setStyleTexts call, which is a substantially larger
// surface. Inline style edits are guaranteed to win the cascade on the
// element and are fully reversible (delete the row), so they are the
// safest pick for a first pass at "edit CSS from the inspector".
//
// Touch-first decisions:
//   - Every row is a 44 px min-height tap target (--tap), so the whole
//     property row selects and opens its editor.
//   - Editing happens in a bottom sheet (StyleEditSheet) with big
//     property/value inputs and prominent Apply / Remove / Cancel
//     buttons — no tiny inline text boxes or hover-only affordances.
//   - Long computed values ellipsize and expand on tap there, rather
//     than inlining a monospace wall.
import { h } from 'preact';
import { useRef, useState, useEffect, useMemo } from 'preact/hooks';
import { markChanged, unmarkChanged, orderChangedFirst, isChanged } from './stylesOrder.js';
import { FILTERS, COMPUTED_PAGE, filterComputed, pageLimit, moreRows, emptyMessage, statusLine } from './computedFilter.js';
import { alternatives, unitOptions, classify, seedValue } from './valueKinds.js';
import { buildValueIndex, scaleFor, tokensFor, scaleNote, valuesFor } from './valueIndex.js';
import { stepFor, snapValue, stepValue as stepValuePure } from './snapping.js';
import { validateDeclaration } from './declaration.js';
import { ConfirmSheet } from './ConfirmSheet.jsx';
import { Suggestions } from './Suggestions.jsx';
import { ValueRail } from './ValueRail.jsx';
import { ValueKindsView } from './ValueKindsView.jsx';
import { StyleControls } from './StyleControls.jsx';
import { AddPropertySheet } from './AddPropertySheet.jsx';
import { createLiveShot } from './liveShot.js';
import { sheetPortal } from './sheetPortal.js';
import { valueShape } from './valueShapes.js';
import { writtenNames } from './shorthand.js';
import { scopeSummary, summarizeReceipt, receiptRows } from './scope.js';
import { ORIGIN_LABEL } from './matchedRules.js';
import { cleanSize } from './targetBar.js';

// valueSwatch — a colour value gets a swatch in front of its text. `rgb(255,
// 230, 0)` is the same length as three other colours at this row size, and the
// inspector is exactly where colours are compared, so the row shows the colour
// as well as its name. Non-colours render nothing (no empty box in front of
// `12px`), and the swatch is decorative: the value text beside it is the
// accessible content, so colour never becomes the only signal.
function valueSwatch(prop, value) {
const raw = String(value == null ? '' : value).trim();
if (!raw) return null;
const verdict = classify(prop, raw);
if (!verdict || verdict.kind !== 'color') return null;
return h('span', {
class: 'inspector__styles-swatch',
style: { background: raw },
'aria-hidden': 'true'
});
}

// Receipt — the changes this session made, newest first, each with the value the
// property had **before the session touched it**. That is what makes one tap of
// ↺ return to the original state rather than to the previous tap, and what lets
// the strip say "1 changed · 3 kept · 0 rules · 0 elements" instead of only
// highlighting a row.
function Receipt(props) {
const receipt = props.receipt || [];
const sum = summarizeReceipt(receipt);
if (!sum.hasChanges) return null;
const rows = receiptRows(receipt);
return h('div', { class: 'inspector__receipt', role: 'group', 'aria-label': 'Changes made in this session' },
h('div', { class: 'inspector__receipt-head' },
h('strong', { class: 'inspector__receipt-title' }, String(sum.count) + (sum.count === 1 ? ' change' : ' changes')),
h('span', { class: 'inspector__receipt-meta' },
[sum.added ? sum.added + ' added' : null, sum.removed ? sum.removed + ' removed' : null].filter(Boolean).join(' · ')
),
h('button', {
class: 'btn inspector__receipt-undoall',
type: 'button',
title: 'Reverse every change in this list',
'aria-label': 'Undo all ' + sum.count + ' changes',
onClick: props.onUndoAll
}, '↺ Undo all')
),
rows.map((r) => h('div', { class: 'inspector__receipt-row', key: r.key },
// The changed value is the control: tapping it reopens the editor on the
// current value, so the strip is not only a list of what happened but a way
// back to the property. A removal has nothing left to edit, so that row
// keeps its value as plain text and offers only the undo button.
props.onEditRow && !r.isRemoval
? h('button', {
class: 'inspector__receipt-main',
type: 'button',
title: 'Edit ' + r.prop,
'aria-label': 'Edit ' + r.prop + ', now ' + r.to,
onClick: () => props.onEditRow(r)
},
h('span', { class: 'inspector__receipt-prop' }, r.prop),
r.wasSet
? h('span', { class: 'inspector__receipt-was', title: 'was ' + r.from }, r.from)
: h('span', { class: 'inspector__receipt-was inspector__receipt-was--unset', title: 'was not set on this element' }, '—'),
h('span', { class: 'inspector__receipt-arrow', 'aria-hidden': 'true' }, '→'),
h('span', { class: 'inspector__receipt-now' }, r.to)
)
: h('span', { class: 'inspector__receipt-main' },
h('span', { class: 'inspector__receipt-prop' }, r.prop),
r.wasSet
? h('span', { class: 'inspector__receipt-was', title: 'was ' + r.from }, r.from)
: h('span', { class: 'inspector__receipt-was inspector__receipt-was--unset', title: 'was not set on this element' }, '—'),
h('span', { class: 'inspector__receipt-arrow', 'aria-hidden': 'true' }, '→'),
h('span', { class: 'inspector__receipt-now is-removed' }, '(removed)')
),
h('button', {
class: 'inspector__receipt-revert',
type: 'button',
title: 'Reverse this change: ' + r.text,
'aria-label': 'Undo ' + r.text,
onClick: () => props.onUndo(r)
}, '↺')
))
);
}

// ValueTypes — the explicit switch between value types, plus the unit cycle for
// the type in force.
//
// A declaration's type is invisible in the panel: `14px`, `14`, `87.5%` and
// `auto` all look like "the value of padding". They are not interchangeable, so
// each alternative states its cost before it is tapped — a lossless form is
// silent, a lossy one names what it discards, and one that cannot be derived
// (a percentage of padding needs the containing block's width, which the
// inspector does not read) is disabled with the reason instead of showing a
// guessed number.
//
// Tapping an alternative only rewrites the field: nothing is written to the page
// until Apply, so a type switch stays one property and one undo entry, and the
// element's other declarations are never touched.
function ValueTypes(props) {
const prop = props.prop || '';
const value = props.value || '';
const ctx = props.ctx || {};
// No value means no type to switch, and every segment would be a disabled chip
// (a conversion has nothing to convert). The sheet seeds a numeric property's
// field with its family's neutral value, so this only hides the switch for the
// families with no neutral form to show — a colour, a keyword, a custom
// property — where the palette / keyword chips are the input instead.
if (!prop || !value) return null;
const alts = alternatives(prop, value, ctx);
const units = unitOptions(prop, value, ctx);
// Nothing to switch between (a single kind, no unit cycle): the switch would be
// a row of one, so it is not rendered at all.
if (alts.length < 2 && units.length < 2) return null;
const current = alts.find((a) => a.isCurrent);
return h('div', { class: 'inspector__valueswitch' },
h('label', { class: 'label' }, 'Value type',
h('span', { class: 'inspector__valueswitch-kind' }, current ? ' — ' + current.label : '')
),
h('div', { class: 'inspector__kindseg', role: 'group', 'aria-label': 'Value type' },
alts.map((a) => h('button', {
class: 'inspector__kindseg-btn' + (a.isCurrent ? ' is-on' : '') + (a.ok ? '' : ' is-blocked'),
type: 'button',
key: a.kind,
'aria-pressed': String(!!a.isCurrent),
disabled: !a.ok || a.isCurrent,
title: a.isCurrent
? a.label + ' — the form this value is in now'
: a.ok
? 'Rewrite as ' + a.label + ': ' + a.value + (a.lossless ? ' (same value)' : ' (' + a.note + ')')
: 'Not available: ' + a.reason,
'aria-label': a.isCurrent
? a.label + ', current'
: a.ok
? 'Use ' + a.label + ', ' + a.value + (a.lossless ? '' : ', ' + a.note)
: a.label + ' unavailable, ' + a.reason,
onClick: () => props.onChange(a.value)
},
h('span', { class: 'inspector__kindseg-name' }, a.label),
h('span', { class: 'inspector__kindseg-val' }, a.isCurrent ? value : (a.ok ? a.value : '—'))
))
),
units.length > 1
? h('div', { class: 'inspector__unitrow', role: 'group', 'aria-label': 'Unit' },
h('span', { class: 'inspector__unitrow-label' }, 'Unit'),
units.map((u) => h('button', {
class: 'inspector__unitchip' + (u.current ? ' is-on' : ''),
type: 'button',
key: u.unit,
disabled: !u.ok,
'aria-pressed': String(!!u.current),
title: u.current ? u.unit + ' — the unit in use'
  : u.ok ? 'Rewrite as ' + u.value + (u.note ? ' (' + u.note + ')' : '') : 'Not available: ' + u.reason,
onClick: () => props.onChange(u.value)
}, u.unit))
)
: null,
// The warning line: what a tap would cost. Shown for the alternatives so the
// user reads it before tapping rather than after.
(() => {
const lossy = alts.filter((a) => !a.isCurrent && a.ok && !a.lossless);
const blocked = alts.filter((a) => !a.isCurrent && !a.ok);
if (!lossy.length && !blocked.length) return null;
return h('p', { class: 'inspector__valueswitch-note' },
lossy.length
? h('span', { class: 'inspector__valueswitch-warn' }, '! ', lossy.map((a) => a.label + ' ' + a.note).join(' · '))
: null,
lossy.length && blocked.length ? ' ' : null,
blocked.length
? h('span', { class: 'inspector__valueswitch-blocked' }, blocked.map((a) => a.label + ': ' + a.reason).join(' · '))
: null
);
})()
);
}

// touchStyleRowLabel — short human label for the element being inspected.
// Builds a DevTools-style `tag#id.class` summary from the DOM node's
// nodeName / attributes. Falls back to the node name alone.
function elementLabel(node) {
if (!node) return '(no element)';
const tag = (node.nodeName || '').toLowerCase();
const attrs = Array.isArray(node.attributes) ? node.attributes : [];
let id = '';
let classes = [];
for (const a of attrs) {
if (a && a.name === 'id') id = a.value || '';
else if (a && a.name === 'class') classes = String(a.value || '').split(/\s+/).filter(Boolean);
}
let label = tag;
if (id) label += '#' + id;
if (classes.length) {
label += classes.slice(0, 3).map((c) => '.' + c).join('');
if (classes.length > 3) label += '…';
}
return label;
}

// boxSummary — one-line size readout from the box model. `box` carries
// width/height as CSS strings (e.g. "373.5px"). We round to whole px for
// display so the panel reads like a metric card, not a debugger dump.
function boxSummary(box) {
if (!box) return '';
const round = (v) => {
const n = parseFloat(v);
return Number.isFinite(n) ? Math.round(n) + 'px' : v;
};
return (box.width ? round(box.width) : '—') + ' × ' + (box.height ? round(box.height) : '—');
}

// COMMON_CSS — the suggested properties at the top of the "Add property" sheet:
// the six a person reaches for first, each with a one-line description and the
// short label its chip carries. Kept intentionally small — the sheet's card list
// and its search field are the way to everything else, and any property can still
// be typed in the editor's own property field.
//
// Each entry is [property, description, chip label]. The label is deliberately
// shorter than the property: the chip row wraps rather than scrolling sideways,
// so `background-color` at 129 px was enough to push the row onto a third line
// for one word. The full property name is what gets applied, and it is in the
// chip's title and accessible name.
const COMMON_CSS = [
['color', 'text color', 'color'],
['background-color', 'background', 'bg'],
['font-size', 'font size', 'size'],
['margin', 'margin', 'margin'],
['padding', 'padding', 'padding'],
['border', 'border', 'border']
];

// STEP_RE — a value the −/+ steppers can nudge: a number with an optional
// unit. Deliberately narrow (`px`, `%`, `rem`, …) so the steppers only show
// up for lengths and unitless numbers — never for colors, keywords, or
// multi-part shorthands where "+1" would be meaningless.
//
// The step itself comes from snapping.js: the page's own numeric step when the
// value index found one (a 4 px design scale nudges by 4, not by 1), and ±1
// otherwise. Negative results clamp at 0 rather than producing an invalid
// `-4px` for a padding.
const STEP_RE = /^(-?\d+(?:\.\d+)?)(px|em|rem|%|vh|vw|pt|ch|ex)?$/;
function stepValue(value, dir, step) {
if (!STEP_RE.test(String(value == null ? '' : value).trim())) return null;
return stepValuePure(value, dir, step);
}
// StyleEditSheet — bottom sheet that edits one property. Shown when the
// user taps a property row or an add-chip. Big inputs, a pinned preview of
// the element being edited, and three actions: Apply (commits to the
// element and keeps the sheet open so the user can keep nudging the same
// property), Remove (drops the property), Cancel/Done.
//
// Applying used to close the sheet, which forced a scroll back to the
// Preview panel to check the result and then a re-open of the sheet to try
// another value. Keeping it open, with the element preview at the top of
// the sheet, turns "edit → look → edit" into one continuous loop.
function StyleEditSheet(props) {
const [prop, setProp] = useState(props.prop || '');
// A property with nothing to copy starts on its family's neutral value rather
// than an empty field (see seedValue): a blank value has no type, so the
// value-type switch, the unit chips and the rail — the controls that answer
// "which unit, and what number?" — were all hidden on exactly the sheet that
// needed them, the one opened from a quick-add chip. Nothing is written to the
// page until Apply.
const [value, setValue] = useState(props.value || seedValue(props.prop));
const [busy, setBusy] = useState(false);
const [error, setError] = useState('');
const [applied, setApplied] = useState(false);
// format — the colour format chips (hex / rgb / hsl). Held here so the choice
// survives a drag on one of the colour rails: writing the value back in the
// format the user picked is the difference between a view and a converter.
const [format, setFormat] = useState(null);
// priority — whether this declaration should be written as `!important`.
//
// It opens with whatever the element already stores for the property, so the
// toggle reflects reality instead of always starting normal: a property the
// page holds as `!important` shows as such, and changing its value keeps the
// priority unless the user turns it off. Two reasons it matters. An inline
// write cannot beat a *stylesheet's* `!important` rule, and the rule wins
// silently — `getPropertyValue` on the inline style returns the value just
// written while `getComputedStyle` still reports the rule's (measured; see
// setInlineStyleProperty). Writing with a priority is how a user overrides such
// a rule. And without carrying the priority across a write, editing the value
// of a declaration the user had already marked important would quietly demote
// it, which changes the cascade far from where the edit was made.
const [priority, setPriority] = useState(props.priority === 'important' ? 'important' : '');
// siblings — what the element's *peers* use for the property being edited
// ("the 2nd section.input-section uses 16px"). Read once per property, because
// it is one page round-trip and only the property in the sheet is interesting;
// a failed read leaves the group out rather than blocking the sheet.
const [siblings, setSiblings] = useState([]);
// Guards every post-await setState: the sheet unmounts on Done/Cancel while
// an apply is still in flight.
const alive = useRef(true);
useEffect(() => () => { alive.current = false; }, []);
// When the sheet opens for a different row / chip, reset the field. A
// `key` on the caller side also does this; resetting here makes the
// component self-contained regardless of how it's mounted.
useEffect(() => {
setProp(props.prop || '');
setValue(props.value || seedValue(props.prop));
setError('');
setApplied(false);
// A different row means a different value: the colour format chips reset so
// they start from whatever format the page itself uses.
setFormat(null);
}, [props.prop, props.value]);
// The priority is reset alongside the field, and from the same source the row
// carries: this effect re-runs when the sheet is handed another property, and a
// priority left over from the previous one would be written onto this one.
useEffect(() => {
setPriority(props.priority === 'important' ? 'important' : '');
}, [props.prop, props.value, props.priority]);
const propName = (prop || '').trim();
// Live validation of the field, run on every keystroke so the sheet can say
// "that is not a value for padding" *before* Apply, instead of the write being
// silently discarded by the CSSOM and the row vanishing afterwards (see
// declaration.js). The capability check is injected because it only exists in a
// browser; without it the shape checks below still run.
const check = useMemo(() => validateDeclaration(
prop,
value,
typeof CSS !== 'undefined' && CSS.supports ? (p, v) => CSS.supports(p, v) : null
), [prop, value]);
// The hint is shown only once the user has something to be wrong about: an
// error on a field they have not finished typing is noise, not help. `dirty`
// flips on the first edit in this sheet session.
const [dirty, setDirty] = useState(false);
const showCheck = dirty && !check.ok;
// The sibling read. Guarded on the property (and on the panel actually giving us
// a reader) so opening the sheet for a property the page cannot answer for costs
// nothing. The reader is held in a ref rather than in the effect's dependencies:
// the panel re-renders on every CDP event and passes a fresh closure each time,
// which would otherwise re-run the read on every console row that lands. It is
// cancelled on unmount / property change, so a slow answer for `padding` cannot
// render under `gap`.
const readSiblingsRef = useRef(props.readSiblings);
readSiblingsRef.current = props.readSiblings;
useEffect(() => {
let live = true;
setSiblings([]);
const read = readSiblingsRef.current;
if (!read || !propName) return () => { live = false; };
read(propName).then((rows) => {
if (live) setSiblings(Array.isArray(rows) ? rows : []);
}).catch(() => { if (live) setSiblings([]); });
return () => { live = false; };
}, [propName]);
// dismiss — leave the sheet, but never silently throw away typed work. The
// sheet is a one-property editor that stays open across several applies, so
// `dirty` (an edit made since the last write) is the only honest signal that
// there is something to lose. Cancel and a tap on the overlay both route
// through here; an unedited sheet — and one whose last edit was already
// applied — closes immediately, which is the common case and must not gain a
// dialogue.
const [confirmDiscard, setConfirmDiscard] = useState(false);
function dismiss() {
if (busy) return;
// `applied` means the field was written and kept: there is nothing pending,
// even though it is still "dirty" relative to the value it opened with.
if (dirty && !applied && check.ok) { setConfirmDiscard(true); return; }
props.onCancel();
}
// The page's own step for this property, when it has one: the steppers move by
// 4px on a 4px design scale instead of by 1, which is what makes −/+ land on
// values the rest of the page actually uses (see snapping.js). The precision
// segment and the rail (later parts) pass their own step and override this.
const pageScale = (props.valueIndex && propName) ? scaleFor(props.valueIndex, propName) : null;
const pageStep = stepFor(pageScale, null);
const down = stepValue(value, -1, pageStep);
const up = stepValue(value, 1, pageStep);
// The snap reading for the typed value: reported by the Suggestions row, which
// owns the hint, and computed once here so the Apply button and the hint agree.
const snap = pageScale ? snapValue(propName, value, pageScale) : null;
// The value rail's context: the page's step and tokens for this property (so the
// rail's ticks are the values the index reports, not invented ones), the sizes
// that turn a length range into the element's own scale, and the unit bases the
// unit chip needs. Assembled once and handed to ValueRail, which is pure.
const railCtx = (() => {
if (!props.valueIndex || !propName) return {};
const scale = scaleFor(props.valueIndex, propName);
const tokens = tokensFor(props.valueIndex, propName).map((t) => ({ name: t.name, value: t.value }));
// A length rail is 0…4× the element's own size, and *which* size is the
// property's business: a box property (`width`, `top`, `max-height`) is measured
// against the element's box, while a spacing, radius or type property is
// measured against its type scale. Using the box width for `padding` would put a
// 16px value on a 448px card at 0.9% of the rail — technically "4× its size"
// and useless to drag.
const BOX_MEASURED = /^(width|height|min-width|max-width|min-height|max-height|top|right|bottom|left|inset|inset-block|inset-inline|block-size|inline-size|flex-basis|outline-offset|text-indent)$/;
const box = (props.box && props.box.width != null) ? props.box : {};
const bases = props.unitCtx || {};
const info = classify(propName, value);
const size = info.kind === 'length'
? (BOX_MEASURED.test(propName)
? (Number(box.height) || Number(box.width))
: bases.fontSize)
: null;
const unitCtx = props.unitCtx || {};
return {
step: stepFor(scale, null),
tokens,
scaleNote: scale && scale.step ? scaleNote(scale) : '',
size: Number.isFinite(size) && size > 0 ? size : null,
fontSize: unitCtx.fontSize,
parentFontSize: unitCtx.parentFontSize,
rootFontSize: unitCtx.rootFontSize,
nearest: snap && snap.offScale && snap.nearest ? snap.nearest.number : null
};
})();
// The shape this sheet shows for the property.
//
// A sheet is one edit session, and the value in its field changes while it is
// open — often with the view's own help. The one case where that would be
// hostile is the fan-out: dragging one side with "link all" on turns
// `10px 14px 18px 14px` into `12px`, and the four rails must not collapse into a
// single slider under the user's finger. So once this sheet has shown a fan-out
// for a property, it keeps showing one until the sheet closes.
const shapeRef = useRef(null);
const liveShape = valueShape(propName, value);
if (shapeRef.current == null) shapeRef.current = { shape: liveShape };
else if (shapeRef.current.shape !== 'fanout' || liveShape === 'fanout') shapeRef.current.shape = liveShape;
const shape = shapeRef.current.shape;
// The rail is the numeric changer; the per-kind views own the other shapes. Both
// only rewrite the value field and neither writes to the page, so which one is
// shown never changes what Apply will do.
const railShape = shape === 'rail' || shape === 'time' || shape === 'angle';
const onField = (next) => { setValue(next); setApplied(false); setError(''); };
// valueInputRef — the typed field, which the rail's double-tap focuses.
const valueInputRef = useRef(null);
const valueChangers = [
railShape
? h(ValueRail, {
key: 'rail',
prop: propName,
value,
ctx: railCtx,
from: props.from,
// The double-tap gesture: the rail writes the value under the finger, and a
// second tap at the same place asks for the keypad, because "nearly 14px" is
// the moment exact typing is the next move. The field is one tap away anyway;
// this saves the tap and the aim.
onKeypad: () => {
const el = valueInputRef.current;
if (!el) return;
try { el.focus(); if (el.select) el.select(); } catch (err) { /* older engines */ }
},
onChange: onField
})
: null,
// The per-kind views (R2): the colour rails and palette, the shorthand fan-out,
// the enum segments, the per-argument rails of a function list, the image
// candidates. Same `onChange` contract, so every kind's edit stays one property
// and one undo entry.
h(ValueKindsView, {
key: 'shape',
prop: propName,
value,
sticky: shape,
format,
onFormat: setFormat,
ctx: railCtx,
step: railCtx.step,
// The keywords the page uses for the property *being edited*: the property field
// is editable inside the sheet, so deriving this from the row it opened with
// would rank a different property's values. The index is the panel's, so this
// still costs no page read.
used: props.valueIndex ? valuesFor(props.valueIndex, propName, 12) : [],
candidates: props.colourCandidates,
background: props.contrastCtx && props.contrastCtx.bg,
contrastCtx: props.contrastCtx,
onChange: onField
})
];
async function commit(p, v) {
if (busy || !props.onApply) return;
setBusy(true);
setError('');
try {
await props.onApply(p, v, priority);
if (!alive.current) return;
setApplied(true);
// The element's box can change size with the property (padding, font
// size) — re-read the pinned preview so the sheet shows the new state.
if (props.onRefreshShot) props.onRefreshShot();
} catch (e) {
if (!alive.current) return;
setError((e && e.message) || 'Could not set ' + p);
} finally {
if (alive.current) setBusy(false);
}
}
async function apply() {
// Same validator as the inline hint, so the button and the message under the
// field can never disagree.
const verdict = validateDeclaration(
prop,
value,
typeof CSS !== 'undefined' && CSS.supports ? (p, v) => CSS.supports(p, v) : null
);
if (!verdict.ok) { setError(verdict.error); return; }
await commit(verdict.prop, verdict.value);
}
// Steppers apply immediately: on a phone, tapping + while watching the
// pinned preview is the fastest way to size something.
async function nudge(next) {
if (!propName || next == null) return;
setValue(next);
await commit(propName, next);
}
async function remove() {
if (!propName) { setError('Property is required.'); return; }
if (busy || !props.onRemove) return;
setBusy(true);
setError('');
try {
await props.onRemove(propName);
if (alive.current) props.onDone();
} catch (e) {
if (!alive.current) return;
setError((e && e.message) || 'Could not remove ' + propName);
setBusy(false);
}
}
return sheetPortal(h('div', { class: 'inspector__overlay', onClick: busy ? undefined : dismiss },
h('div', {
class: 'inspector__sheet inspector__sheet--style',
role: 'dialog',
'aria-modal': 'true',
'aria-label': 'Edit ' + (propName || 'style'),
onClick: (e) => e.stopPropagation()
},
h('div', { class: 'inspector__sheet-head' },
h('strong', { class: 'inspector__sheet-title' }, propName ? 'Edit ' + propName : 'Add style'),
h('button', { class: 'btn inspector__sheet-close', type: 'button', onClick: dismiss }, applied ? 'Done' : 'Cancel')
),
h('div', { class: 'inspector__sheet-body inspector__sheet-body--style' },
// Pinned element preview — the reason the sheet can stay open. Tap it to
// re-capture when a property changed the page outside this edit.
props.shot
? h('button', {
class: 'inspector__styles-shot inspector__styles-shot--sheet',
type: 'button',
title: 'Tap to refresh the element preview',
'aria-label': 'Refresh the element preview',
disabled: !!props.shotBusy,
onClick: props.onRefreshShot
},
h('img', { class: 'inspector__styles-shot-img', src: props.shot, alt: 'Preview of the edited element', draggable: 'false' })
)
: null,
h('label', { class: 'label' }, 'Property'),
h('input', {
class: 'input inspector__style-input',
type: 'text',
value: prop,
placeholder: 'e.g. background-color',
autocapitalize: 'off',
autocorrect: 'off',
spellcheck: false,
onInput: (e) => { setProp(e.currentTarget.value); setApplied(false); setDirty(true); }
}),
h('label', { class: 'label' }, 'Value'),
// The value-type switch sits directly above the value field: it changes the
// form of that value, so it has to be read before the field, not after.
h(ValueTypes, {
prop: propName,
value,
ctx: props.unitCtx,
onChange: (next) => { setValue(next); setApplied(false); setError(''); }
}),
// The page's own values and tokens for this property, once there is a property
// to look up. Placed under the type switch so the order reads "what form, then
// which value". `value` goes along so the row can place the value being typed on
// the page's own scale, and `contrastCtx` carries the element's resolved
// background and text colours for the colour chips' WCAG ratios.
//
// `ownColour` is set once the sheet has decided a colour value gets its own view:
// the three rails and the palette below already show the palette with a ratio
// badge per swatch, so this row drops its colour group rather than rendering the
// same candidates twice.
h(Suggestions, {
index: props.valueIndex,
prop: propName,
value,
contrastCtx: props.contrastCtx,
ownColour: shape === 'colour',
// The view the sheet picked. A `text` value has no per-kind view of its own, so
// this is what tells the row that the keyword forms are the only chips worth
// adding (see Suggestions.jsx).
shape: shape,
// What the peers use for this property — the one group the page's own
// stylesheets cannot answer.
siblings: siblings,
onPick: (next) => { setValue(next); setApplied(false); setError(''); }
}),
...valueChangers,
h('div', { class: 'inspector__style-valuerow' },h('button', {
class: 'inspector__style-step',
type: 'button',
disabled: busy || down == null,
'aria-label': 'Decrease ' + (propName || 'value'),
title: down == null ? 'Not a number'
: 'Decrease to ' + down + (pageStep ? ' — the page\'s ' + pageStep + (pageScale.unit || '') + ' step' : ''),
onClick: () => nudge(down)
}, '−'),
h('input', {
class: 'input inspector__style-input inspector__style-input--value',
type: 'text',
ref: valueInputRef,
value,
placeholder: 'e.g. #ffcc00',
autocapitalize: 'off',
autocorrect: 'off',
spellcheck: false,
onInput: (e) => { setValue(e.currentTarget.value); setApplied(false); setDirty(true); }
}),
h('button', {
class: 'inspector__style-step',
type: 'button',
disabled: busy || up == null,
'aria-label': 'Increase ' + (propName || 'value'),
title: up == null ? 'Not a number'
: 'Increase to ' + up + (pageStep ? ' — the page\'s ' + pageStep + (pageScale.unit || '') + ' step' : ''),
onClick: () => nudge(up)
}, '+')
),
// The page's step and where the typed value sits on it. The nudge pair moves in
// whole steps, so this line is the answer to "why did + jump by 4?".
pageStep && snap
? h('p', { class: 'inspector__style-step-note' },
'Stepping by ' + pageStep + (pageScale.unit || '') + ' — this page\'s own scale',
snap.offScale && snap.nearest ? ' · nearest ' + snap.nearest.value : ''
)
: null,
// Priority — the `!important` toggle, as one 44 px hit target.
//
// It is a toggle rather than a checkbox so the state is the label: the button
// reads "normal" or "!important", and the accessible name says which one a tap
// will produce. This is the control that makes an edit stick against a
// stylesheet rule marked `!important`, and the only way for the panel to say
// that a declaration it is showing carries priority — which is why it sits with
// the value rather than behind an overflow: a priority the user cannot see is a
// cascade outcome they cannot explain.
h('div', { class: 'inspector__style-priorityrow' },
h('span', { class: 'inspector__style-prioritylabel' }, 'Priority'),
h('button', {
class: 'inspector__style-priority' + (priority === 'important' ? ' is-on' : ''),
type: 'button',
'aria-pressed': String(priority === 'important'),
'aria-label': priority === 'important'
? 'Priority important — tap to use a normal declaration'
: 'Priority normal — tap to mark this declaration important',
title: priority === 'important'
? 'Written as !important — it beats other declarations on this element'
: 'Normal declaration — a stylesheet rule marked !important will still win',
onClick: () => setPriority(priority === 'important' ? '' : 'important')
}, priority === 'important' ? '!important' : 'normal'),
h('span', { class: 'inspector__style-priorityhint' },
priority === 'important'
? 'Beats other declarations on this element'
: 'A stylesheet !important rule still wins — tap to override it'
)
),
// The scope block states what Apply will and will not do, in numbers computed
// from the element's real declarations (see scopeSummary): one property
// changes, the rest are kept, no stylesheet rule is touched and no other
// element is affected. The generic hint underneath used to be the whole story
// ("this sets the element's own inline style"), which answered a different
// question than "what else does this disturb?".
(() => {
const scope = scopeSummary({ declared: props.declared || [], edited: propName });
if (!props.isInline) return null;
return h('div', { class: 'inspector__scope' },
h('div', { class: 'inspector__scope-head' }, 'Only one thing changes'),
h('div', { class: 'inspector__scope-grid' },
h('span', null, 'Properties changed ', h('b', null, String(scope.changed))),
h('span', null, 'Declarations kept ', h('b', null, String(scope.kept))),
h('span', null, 'Rules edited ', h('b', null, String(scope.rulesEdited))),
// Structurally zero: the write addresses the resolved element's own style
// object, so no selector can match a second element. Printed rather than
// implied because "did I just change something else?" is the question.
h('span', null, 'Other elements ', h('b', { class: 'inspector__scope-zero' }, '0'))
),
scope.added
? h('p', { class: 'inspector__scope-note' }, 'Adds ' + propName + ' to this element — it had no declaration of its own before.')
: null,
h('p', { class: 'inspector__scope-note inspector__scope-kept' }, 'Every other declaration on this element is kept as it is.')
);
})(),
applied ? h('p', { class: 'inspector__style-applied', role: 'status' }, 'Applied — keep editing or tap Done') : null,
// The live verdict from declaration.js. Shown in place of the post-write error
// while the user is still typing, so an invalid value is named *before*
// Apply — the write path itself would silently discard it (see declaration.js).
showCheck && !error ? h('p', { class: 'inspector__style-error', role: 'status' }, check.error) : null,
error ? h('p', { class: 'inspector__style-error', role: 'alert' }, error) : null,
h('div', { class: 'inspector__sheet-actions' },
h('button', {
class: 'btn inspector__style-apply',
type: 'button',
// Disabled on an invalid field as well as a busy one: a button that is
// guaranteed to fail should not be tappable. The hint above says why.
disabled: busy || !check.ok,
title: check.ok ? 'Apply this declaration to the element' : check.error,
onClick: apply
}, busy ? 'Applying…' : 'Apply'),
props.isRemove
? h('button', {
class: 'btn btn--danger inspector__style-remove',
type: 'button',
disabled: busy,
onClick: remove
}, 'Remove')
: null
)
),
// Discard guard for typed-but-unapplied work. Reuses the Inspector's own
// in-app sheet (not window.confirm, which some embedded web views suppress —
// see ConfirmSheet's header), so it appears where the user is looking and
// keeps both buttons at the tap minimum.
confirmDiscard
? h(ConfirmSheet, {
open: true,
title: 'Discard this change?',
message: 'Your edit to ' + (propName || 'this property') + ' has not been applied. Leaving now keeps the value the element has.',
confirmLabel: 'Discard',
cancelLabel: 'Keep editing',
onCancel: () => setConfirmDiscard(false),
onConfirm: () => { setConfirmDiscard(false); props.onCancel(); }
})
: null
)
));
}

// MatchedRulesSection — the read-only "where does this value come from"
// answer: every rule that matches the selected element, most specific
// first, with each rule's selector, origin, @media condition, and
// declarations. Tapping a declaration opens the edit sheet pre-filled with
// that property and value, which is the whole point of the section: a value
// supplied by a class is otherwise invisible and looks uneditable, and the
// fastest fix for "I want this one thing different" is to copy it onto
// `element.style` and change it.
//
// Collapsed by default. The section is an answer to a question, not
// something to scroll past on every selection, and an element on a real
// site matches enough rules (plus a dozen browser defaults) to be another
// wall. Browser defaults get their own labelled toggle for the same reason.
function MatchedRulesSection(props) {
const all = props.rules || [];
const counts = props.counts || { total: 0, userAgent: 0 };
const visible = all.filter((r) => props.showUa || r.group !== 'user-agent');
// open — which rules show their declarations. A rule card is a header plus
// one row per declaration, and a real page matches enough of them that
// rendering every declaration put ~9 000 px into a 352 px panel. Rules are
// therefore collapsed to their header, and only the first (the most
// specific, so the one usually being asked about) starts open, so the
// section opens on something meaningful instead of either a wall or nothing.
const firstId = visible.length ? visible[0].id : null;
const [open, setOpen] = useState(() => (firstId ? { [firstId]: true } : {}));
// Re-seed when the selection changes (the same rule ids come back for a
// different element, so the previous element's open rules would be wrong) or
// when the browser-defaults toggle changes which rule is first.
useEffect(() => {
setOpen(firstId ? { [firstId]: true } : {});
}, [props.selectionKey, firstId]);
function toggleRule(id) {
setOpen((prev) => {
const next = { ...prev };
if (next[id]) delete next[id];
else next[id] = true;
return next;
});
}
let body = null;
// uaToggle — the browser-default control, in the list it filters rather than
// in the bar above it. A two-letter "UA" pill next to "Show" told the reader
// nothing (it is DevTools shorthand for the user-agent stylesheet), and a
// label long enough to be understood does not fit the 320 px bar alongside
// the heading, the count, and "Show rules". Here it has a full row and says
// exactly what it does — and it sits where the rules it reveals would appear,
// under the author rules that they would otherwise bury.
const uaToggle = counts.userAgent
? h('button', {
class: 'inspector__rules-ua' + (props.showUa ? ' is-on' : ''),
type: 'button',
key: 'ua',
'aria-pressed': String(!!props.showUa),
onClick: props.onToggleUa
}, (props.showUa ? 'Hide ' : 'Show ') + counts.userAgent + ' browser default rule'
+ (counts.userAgent === 1 ? '' : 's'))
: null;
if (props.open) {
if (!all.length) {
body = h('p', { class: 'inspector__styles-none', role: 'status' },
props.busy ? 'Reading the cascade…' : 'No stylesheet rules matched this element.');
}
else {
body = [
visible.length
? h('ul', { class: 'inspector__rules', key: 'list' },
visible.map((r) => {
const isOpen = !!open[r.id];
return h('li', {
class: 'inspector__rule' + (r.group === 'user-agent' ? ' is-ua' : '') + (r.inherited ? ' is-inherited' : ''),
key: r.id
},
h('button', {
class: 'inspector__rule-head',
type: 'button',
'aria-expanded': String(isOpen),
'aria-label': (isOpen ? 'Hide' : 'Show') + ' the ' + r.props.length + ' declaration'
+ (r.props.length === 1 ? '' : 's') + ' of ' + r.selector
+ (r.inherited ? ', inherited from ' + r.inherited : ''),
title: isOpen ? 'Hide declarations' : 'Show declarations',
onClick: () => toggleRule(r.id)
},
h('span', { class: 'inspector__rule-caret', 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
h('span', { class: 'inspector__rule-sel' }, r.selector),
r.group === 'user-agent' ? h('span', { class: 'inspector__rule-tag' }, ORIGIN_LABEL['user-agent']) : null,
r.media ? h('span', { class: 'inspector__rule-tag inspector__rule-tag--media', title: '@media ' + r.media }, '@media ' + r.media) : null,
r.inherited ? h('span', { class: 'inspector__rule-tag inspector__rule-tag--inh' }, 'from ' + r.inherited) : null,
h('span', { class: 'inspector__rule-n', 'aria-hidden': 'true' },
String(r.props.length) + (r.more ? '+' + r.more : ''))
),
isOpen
? h('ul', { class: 'inspector__rule-props' },
r.props.map((p) => h('li', { key: r.id + ':' + p.name },
h('button', {
class: 'inspector__rule-prop' + (p.disabled ? ' is-off' : ''),
type: 'button',
title: 'Set ' + p.name + ' on this element',
'aria-label': 'Set ' + p.name + ', ' + p.value + (p.important ? ' important' : '') + ', on this element as an inline style',
onClick: () => props.onEdit(p.name, p.value)
},
h('span', { class: 'inspector__rule-pname' }, p.name),
h('span', { class: 'inspector__rule-pval' }, p.value + (p.important ? ' !important' : ''))
)
)),
r.more ? h('li', { class: 'inspector__rule-more' }, '+' + r.more + ' more') : null
)
: null
);
})
)
: h('p', { class: 'inspector__styles-none', key: 'only-ua', role: 'status' },
'Only browser default rules matched this element.'),
props.truncated
? h('p', { class: 'inspector__rules-truncated', key: 'cut' }, '+' + props.truncated + ' more rules not shown')
: null,
uaToggle
];
}
}
return h('div', { class: 'inspector__styles-section' },
h('div', { class: 'inspector__rules-bar' },
h('h3', { class: 'inspector__styles-h' }, 'Matched rules'),
h('span', { class: 'inspector__rules-count' }, props.busy && !all.length ? '…' : String(visible.length)),
// "Show rules", not "Show": the button opens the list of rules under it, and
// the word on its own gave no clue what would be shown. The count beside the
// heading already says how many there are; the accessible name spells it out.
h('button', {
class: 'inspector__rules-toggle',
type: 'button',
'aria-expanded': String(!!props.open),
'aria-label': (props.open ? 'Hide' : 'Show') + ' the rules that match this element'
+ (visible.length ? ' (' + visible.length + ')' : ''),
onClick: props.onToggle
}, props.open ? 'Hide rules' : 'Show rules')
),
body
);
}
// StylesPanel — the whole "Styles" tab body.
export function StylesPanel(props) {
const [model, setModel] = useState(null);
const [loading, setLoading] = useState(false);
const [error, setError] = useState('');
const [edit, setEdit] = useState(null); // { prop, value } when editing
// addOpen — whether the "Add property" card sheet is up. The sheet is the browse
// step between the touch surface's primary button and the edit sheet: it chooses
// a *property*, then hands it to the same editor a declared row opens.
const [addOpen, setAddOpen] = useState(false);
const [selValue, setSelValue] = useState('');
// shot — the pinned element preview: a clipped screenshot of the selected
// element (data URL) plus its device-pixel size. Shown at the top of the
// panel and inside the edit sheet so an edit's result is readable without
// scrolling the page back up to the Preview panel.
const [shot, setShot] = useState(null);
const [shotBusy, setShotBusy] = useState(false);
// changed — property names edited in this session, most recent first. They
// are hoisted to the top of the Declared and Computed lists and highlighted,
// so "what did I change and what is it now?" is answerable at a glance
// instead of hunting through ~400 computed rows.
const [changed, setChanged] = useState([]);
// receipt — the session's edits. The LIST is owned by the Inspector (so it
// survives this panel being switched off, and so the target bar can undo while
// the user is reading Console output); this panel renders it, records into it,
// and asks the parent to reverse an entry.
const receipt = props.receipt || [];
// receiptNonce — bumped by the parent after an undo it performed itself, so this
// panel re-reads the element: its copy of the declarations is stale by then.
useEffect(() => {
if (!props.receiptNonce) return;
// The parent reversed an entry, so everything a write touched is stale: the
// inline declarations, and the matched rules that carry the element's own
// `element.style` entry (what the origin sentence is built from).
revalidate();
captureShot();
}, [props.receiptNonce]);
// adoptRestored — take back the selection the Inspector retained.
//
// This panel unmounts when its chip is switched off, which loses its model
// (element, tree, rules, receipt) while the parent still holds the objectId. On
// mount, if this panel has nothing selected and the parent names an element, the
// element is re-read through the same path as a Refresh — so switching to
// Console and back, or undoing from the bar while this panel was hidden, lands
// on the element that is still on screen above, rather than on an empty panel.
//
// The mark in `adoptedRef` is what keeps that from undoing **Clear**: clearing
// leaves this panel in exactly the state the effect looks for (no model, a
// retained id), so without the mark the element came straight back one
// round-trip later and the ✕ read as a button that does nothing. `clearPick`
// marks the id it dropped; a later mount starts with no mark, so a panel that
// has just been switched back on still adopts.
const adoptedRef = useRef('');
useEffect(() => {
const objectId = props.restoreObjectId || '';
if (!objectId || adoptedRef.current === objectId) return;
if (modelRef.current) return;              // a live selection of our own wins
if (!props.refreshNodeModel) return;
adoptedRef.current = objectId;
loadModel(() => props.refreshNodeModel(objectId));
});

// tree — the selected element's ancestors and direct children (see
// readElementTree). Rendered as the breadcrumb at the top of the pinned
// block and as the child chips under it, so the user can walk up or down
// the DOM without going back to the live preview to tap again.
const [tree, setTree] = useState(null);
const modelRef = useRef(null);
// treeSerial — same guard as shotSerial: only the newest tree read may
// write to state, so a slow read for a previously selected element can
// never overwrite the current element's breadcrumb.
const treeSerial = useRef(0);
// crumbsRef — the breadcrumb strip, which is one line that scrolls sideways
// (see .inspector__styles-crumbs). The interesting end of a path is the current
// element, i.e. the last chip, so the strip is scrolled to its end on every new
// selection: a deep element would otherwise open on `html › body` while the
// element itself sat off the right edge, which is the one chip the row exists to
// show. Keyed on the selection *and* on the tree read, because the tree arrives
// a round-trip after the selection does.
const crumbsRef = useRef(null);
const crumbsKey = (model && model.objectId) || '';
useEffect(() => {
const strip = crumbsRef.current;
if (!strip) return;
strip.scrollLeft = strip.scrollWidth;
}, [crumbsKey, tree]);
// panelRef — this panel's own scroller, and the handle every reveal below uses.
// The panel scrolls itself rather than the page: the panels are stacked in
// `.app__main`, and scrolling that instead would drag the whole Inspector —
// panel bar, status pill and every other panel — while the user is working
// inside one card.
const panelRef = useRef(null);
// tabsRef — the touch surface's group chip row, published by StyleControls (it
// owns the node; this panel owns the scrolling).
const tabsRef = useRef(null);
// revealRef — the surface's own reveal, called back *after* the new group has
// rendered. The chip row is the one node that has to stay put across a group
// change: switching group replaces every card below it, so a user who had
// scrolled down to read a group's last card would otherwise land past the end of
// the new one and see an empty panel. Doing it from an effect (rather than in
// the tap handler) means the offset is measured against the cards the tap
// actually produced.
const revealRef = useRef(null);
// touchGroup — which group the touch surface is showing, owned here as well as
// in the surface so *this* panel can scroll the chip row back into view once the
// new group has rendered (see revealRef). It is only ever set by a tap on a chip
// and the surface remounts per element, so it never has to survive a selection.
const [touchGroup, setTouchGroup] = useState('');
// The chip row is scrolled into view *after* the new group has rendered: this
// effect runs post-render, so the cards below the row already belong to the
// group the user tapped and the measurement is against the new height.
useEffect(() => {
// An empty `touchGroup` means "no group has been tapped yet" — including on the
// panel's first mount, where revealing would scroll down to a chip row the user
// has not touched.
if (!touchGroup) return;
const reveal = revealRef.current;
if (reveal) reveal();
}, [touchGroup]);
// revealElement — a new selection scrolls this panel back to its top, which is
// where the element's identity, its pinned preview and the Style controls row
// are. Walking the element tree makes this plainest: the tree and the preview
// both live in the sticky block, so without it a hop from a node read at the
// bottom of the panel (a 2 600 px scroller on the fixture below) landed on the
// new element with its own preview and chip row 2 193 px above the viewport.
// Only a *new* element reveals: re-reading the same one (a write, a Refresh, the
// live preview loop) must leave the user where they were reading.
const revealedRef = useRef('');
useEffect(() => {
const objectId = (model && model.objectId) || '';
if (!objectId) { revealedRef.current = ''; return; }
if (revealedRef.current === objectId) return;
revealedRef.current = objectId;
const panel = panelRef.current;
if (panel) panel.scrollTop = 0;
}, [crumbsKey]);
// rules — the cascade, read-only: every rule that matches the selected
// element, plus the rules it inherits from its ancestors. Answering "which
// class put this value here" is what makes the editable list above
// actionable instead of mysterious — a value coming from a class looks
// permanently uneditable until the rule supplying it is on screen and can
// be brought into `element.style` in one tap.
const [rules, setRules] = useState(null);
const [rulesBusy, setRulesBusy] = useState(false);
// Collapsed by default: the section is an answer to a question ("why is it
// this value?"), not something to scroll past on every selection. Browser
// defaults are hidden behind their own labelled toggle because a dozen of them
// per element bury the author rule that matters.
const [rulesOpen, setRulesOpen] = useState(false);
const [showUa, setShowUa] = useState(false);
// kidsOpen — whether the children chips are shown. The breadcrumb is always
// on screen (it answers "where am I"), but the child chips are a browsing aid
// used deliberately and rarely, and a wrapped row of them is 3-5 lines tall.
// Collapsed, the Element tree section is one or two breadcrumb lines.
const [kidsOpen, setKidsOpen] = useState(false);
// rulesSerial — same newest-read-wins guard as treeSerial/shotSerial.
const rulesSerial = useRef(0);
// The Computed list is every property the browser resolves — ~400 rows on a
// typical page — and had no way to narrow it. `query` searches property names
// and resolved values; `view.filter` picks one of all / set / changed (see
// computedFilter.js); `view.steps` is how many extra pages of rows the user
// asked for. They live in one state object so changing the query or the filter
// can reset `steps` in the same update: a stale expanded view after narrowing
// the list would render every row the user just filtered out.
const [computedView, setComputedView] = useState({ query: '', filter: 'all', steps: 0 });
const computedQuery = computedView.query;
const computedFilter = computedView.filter;
const computedSteps = computedView.steps;
// computedMoreRef — how many rows one more step would reveal, mirrored
// into a ref so the panel's scroll handler (defined above the render,
// where `computedMore` does not exist yet) can read the current value
// without being re-created on every render.
const computedMoreRef = useRef(0);
function setComputedQueryState(query) {
setComputedView((v) => ({ ...v, query: String(query || ''), steps: 0 }));
}
function setComputedFilterState(filter) {
setComputedView((v) => ({ ...v, filter, steps: 0 }));
}
function setComputedSteps(steps) {
setComputedView((v) => ({ ...v, steps: Math.max(0, steps) }));
}
// onPanelScroll — page the Computed list in as the user reads down to its
// end. The list renders one page of 60 rows at a time (see computedFilter.js)
// and the "Show N more" button at its foot reveals the next one — but that
// button sits at the bottom of a scroller that is ~2 600 px tall for a
// typical element, so reaching it is itself a 30-row read with nothing to
// say the list continues. Scrolling to the end of what is rendered now
// reveals the next page on its own: the same steps counter the button uses,
// so the button's label stays honest ("Show 60 more of 406" counts what is
// still hidden) and tapping it still jumps a page ahead from anywhere.
//
// The threshold is one row-and-a-bit (~40 px per row): close enough that the
// next page is on screen before the user hits the hard end, far enough that
// reading the middle of the list never pages anything in. The guard on
// `computedMoreRef` means a fully-shown list (or an empty filter result)
// costs nothing per scroll event.
function onPanelScroll() {
const panel = panelRef.current;
if (!panel || computedMoreRef.current <= 0) return;
const remaining = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
if (remaining > 72) return;
setComputedView((v) => ({ ...v, steps: v.steps + 1 }));
}
// shotSerial — only the newest capture may write to state. Picks, applies,
// and manual refreshes can overlap, and a slow capture for a previously
// selected element must not replace the current element's preview.
const shotSerial = useRef(0);
// lastShotData — the raw base64 of the capture that is on screen. The live
// re-capture below compares against it and drops a byte-identical image before
// it reaches the DOM: an unchanged element costs no decode, no layout and no
// scroll write, exactly like the Preview panel's own unchanged-frame drop. It
// is also what makes "the preview is live" free on an idle page.
const lastShotData = useRef('');
// manualShotBusy — whether a *user-asked* capture (a pick, an edit, a tap on
// the image, the card header's Refresh) is in flight. The live loop stands down
// while one is: the manual capture is the one the user is waiting for, and it
// may have been asked for *because* the page changed outside the panel.
const manualShotBusy = useRef(false);
// shotLiveBusy — an automatic capture in flight. Cheap guard, but it is what
// keeps a slow page from stacking ticks (the loop also schedules the next one
// only after the previous finished).
const shotLiveBusy = useRef(false);
// captureShot — grab a clipped screenshot of the currently selected
// element. Never throws: a failed capture leaves the previous preview in
// place rather than blanking the panel.
async function captureShot() {
const objectId = modelRef.current && modelRef.current.objectId;
if (!objectId || !props.captureElementShot) return;
const serial = ++shotSerial.current;
manualShotBusy.current = true;
setShotBusy(true);
try {
const r = await props.captureElementShot(objectId);
if (serial !== shotSerial.current) return;
if (r && r.data) {
lastShotData.current = r.data;
setShot({ src: 'data:image/png;base64,' + r.data, width: r.width, height: r.height });
}
} catch { /* keep the previous preview */ } finally {
manualShotBusy.current = false;
if (serial === shotSerial.current) setShotBusy(false);
}
}
// captureShotLive — the loop's capture. Same clipped screenshot, three
// deliberate differences from `captureShot` above:
//
//   1. `scroll: false` — it never centres the element, because it runs while
//      the user reads and edits (an element off screen still captures: the clip
//      is in document space).
//   2. it never touches `shotBusy`, so an automatic tick cannot make the
//      caption flash "Updating…" or disable the tap-to-refresh button under the
//      user's finger; the size readout on the caption is what moves.
//   3. it does not take a `shotSerial`, so a tick can never cancel a capture the
//      user asked for; instead it drops its own result when a manual capture
//      started (or the selection moved) while it was in flight.
//
// A capture that returns nothing (an element with no box, a detached node, a
// target that refuses viewport-only clips) leaves the previous image alone.
async function captureShotLive() {
const objectId = modelRef.current && modelRef.current.objectId;
if (!objectId || !props.captureElementShot) return;
if (manualShotBusy.current) return;
if (shotLiveBusy.current) return;
shotLiveBusy.current = true;
try {
const r = await props.captureElementShot(objectId, { scroll: false });
if (!r || !r.data) return;
if (manualShotBusy.current) return;
if (r.data === lastShotData.current) return;
const cur = modelRef.current;
if (!cur || cur.objectId !== objectId) return;
lastShotData.current = r.data;
setShot({ src: 'data:image/png;base64,' + r.data, width: r.width, height: r.height });
} catch { /* keep the previous preview */ } finally {
shotLiveBusy.current = false;
}
}
// The live preview loop. While an element is selected, the pinned capture is
// kept in step with the page instead of only reflecting what this panel did
// last: an edit typed into the page, a field filled from the Preview panel's
// type bar, an animation, or the page's own script all show up here without a
// tap. The pacing (one capture at a time, paused in the background, standing
// down for a manual capture) lives in liveShot.js so it is testable on its own.
useEffect(() => {
const objectId = model && model.objectId;
if (!objectId || !props.captureElementShot) return;
const loop = createLiveShot({
capture: captureShotLive,
isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
});
loop.start();
return () => loop.stop();
}, [model && model.objectId, props.captureElementShot]);
// loadTree — read the selected element's ancestors and children for the
// breadcrumb / child chips. Best-effort and non-blocking: the property
// lists must not wait on it, and a target that can't answer leaves the tree
// strip hidden rather than showing a broken row.
function loadTree(m) {
const objectId = m && m.objectId;
if (!objectId || !props.readElementTree) { treeSerial.current++; setTree(null); return; }
const serial = ++treeSerial.current;
Promise.resolve(props.readElementTree(objectId))
.then((t) => { if (serial === treeSerial.current) setTree(t); })
.catch(() => { if (serial === treeSerial.current) setTree(null); });
}
// selectAncestor / selectChild — walk one step in the DOM tree. The parent
// helper returns a complete node model, so the result is adopted exactly
// like a fresh pick: same code path as tapping the live preview, which
// keeps the breadcrumb, the pinned preview, the changed-set reset, and the
// highlight all in sync for free.
function selectAncestor(levels) {
const objectId = modelRef.current && modelRef.current.objectId;
if (!objectId || !props.selectAncestorNode) return;
loadModel(() => props.selectAncestorNode(objectId, levels).then((m) => {
if (!m) throw new Error('Nothing above this element.');
return m;
}));
}
function selectChild(index) {
const objectId = modelRef.current && modelRef.current.objectId;
if (!objectId || !props.selectChildNode) return;
loadModel(() => props.selectChildNode(objectId, index).then((m) => {
if (!m) throw new Error('That child is no longer on the page.');
return m;
}));
}
// applyModel — adopt a freshly built node model: store it, clear the
// previous element's preview immediately (so a stale image never sits above
// a new element's properties), then capture the new one.
function applyModel(m) {
// A different element means the previous edits' highlight is meaningless
// (the properties belong to the old node). A refresh of the same element
// keeps it.
const prevId = modelRef.current && modelRef.current.objectId;
if (!m || m.objectId !== prevId) { setChanged([]); if (props.onSelectionReset) props.onSelectionReset(); }
setModelBoth(m);
shotSerial.current++;
// The previous element's capture is meaningless for this one, in the cache as
// well as on screen: the live loop compares against `lastShotData`, so leaving
// it behind would drop the new element's first capture when the two happen to
// be byte-identical (two identical buttons, a repeated card).
lastShotData.current = '';
setShot(null);
setShotBusy(false);
captureShot();
loadTree(m);
loadRules(m);
}
// loadRules — read the matched cascade for the selected element. Same
// non-blocking, newest-read-wins treatment as the tree and the pinned
// preview: the property lists must never wait on the cascade read, and a
// slow answer for a previously selected element must not replace the
// current element's rules.
async function loadRules(m) {
const objectId = m && m.objectId;
if (!objectId || !props.readMatchedRules) { rulesSerial.current++; setRules(null); return; }
const serial = ++rulesSerial.current;
setRulesBusy(true);
try {
const r = await props.readMatchedRules(objectId);
if (serial === rulesSerial.current) setRules(r);
} catch {
if (serial === rulesSerial.current) setRules(null);
} finally {
if (serial === rulesSerial.current) setRulesBusy(false);
}
}

// Dim down the inline-style list while stale after an edit. The page
// recomputes, so we hold the previous model and keep a "refresh" affordance.
async function loadModel(fn) {
setLoading(true);
setError('');
try {
const m = await fn();
if (m) applyModel(m);
} catch (e) {
setError((e && e.message) || 'Could not inspect element');
} finally {
setLoading(false);
}
}

// pickFromPoint — called by the InspectorView when the user taps the
// preview in "pick" mode (see InspectorView's StylesPanel wiring).
async function pickFromPoint(x, y) {
if (!props.pickNodeAt) return false;
setError('');
try {
const m = await props.pickNodeAt(x, y);
if (m) { applyModel(m); return true; }
setError('Nothing selectable at that point.');
return false;
} catch (e) {
setError((e && e.message) || 'Inspect failed');
return false;
}
}

// pickBySelector — select an element by CSS selector text, typed in the
// small field above the property list. A no-preview fallback.
async function pickBySelector() {
if (!props.selectBySelector || !(selValue || '').trim()) return;
setLoading(true);
setError('');
try {
const m = await props.selectBySelector(selValue);
if (m) applyModel(m);
else setError('No element matches “' + selValue.trim() + '”.');
} catch (e) {
setError((e && e.message) || 'Selector failed');
} finally {
setLoading(false);
}
}

// Expose the pick-from-point handler up to the InspectorView so the
// preview tap can be routed here when "pick mode" is on. Runs on every
// render so the ref always closes over the latest props/state; the
// cleanup nulls the ref on unmount so a hidden Styles panel can't leave
// a stale handler wired to the preview.
useEffect(() => {
if (props.pickHandlerRef) props.pickHandlerRef.current = pickFromPoint;
return () => { if (props.pickHandlerRef) props.pickHandlerRef.current = null; };
});
// Publish the selection so the TargetBar above the panels can show the
// element, its rule chips and where an edit lands. The bar is a separate
// component (and can be seen while this panel is hidden), so the data has to
// leave here — but the *selection* stays owned by this panel, which is what
// keeps tap-to-select, the tree, and the pinned preview working exactly as
// before. `onSelectionChange` is optional: without it this panel behaves as it
// always did.
useEffect(() => {
if (!props.onSelectionChange) return;
props.onSelectionChange({
label: model ? elementLabel(model.node) : '',
size: boxSummary(model && model.box),
objectId: (model && model.objectId) || '',
declared: (model && model.inlineProps) || [],
rules: rules || null,
tree: tree || null,
changed: changed || [],
receipt: receipt || [],
editing: edit ? edit.prop : '',
// busy — a read of this element is in flight (a selection, a refresh, a
// re-read after an undo). The panel's own header buttons live in the card
// header now, so this is how that header knows to disable Refresh while the
// read it would duplicate is already running.
busy: !!loading
});
// Clear the published snapshot on unmount. The Inspector keeps its own copy so
// the target bar and the receipt survive this panel being switched off — which
// is the point of the store — but it must stop reading a live snapshot that no
// longer has a panel behind it, or the bar would describe an element the panel
// is no longer tracking.
return () => { if (props.onSelectionChange) props.onSelectionChange(null); };
}, [model, rules, tree, changed, receipt, edit, loading]);
// Expose the panel's own actions to the TargetBar above it, so the bar's
// header buttons and breadcrumb are shortcuts into this panel rather than a
// second implementation. The selection stays owned here (with the highlight,
// pinned preview and changed-set reset that go with it); the bar only asks.
useEffect(() => {
if (!props.panelHandlesRef) return;
props.panelHandlesRef.current = {
  // Move the selection up the tree. `levels` is the hop count readElementTree
  // returns (the same number this panel's own breadcrumb passes), with a label
  // match as a fallback so a crumb from a stale tree still works.
  selectAncestor: (crumb) => {
    if (!crumb) return Promise.resolve(false);
    const list = (tree && tree.ancestors) || [];
    const found = list.find((a) => a && a.label === crumb.label);
    const levels = crumb.levels != null ? crumb.levels : (found && found.levels);
    if (levels == null) return Promise.resolve(false);
    return selectAncestor(levels);
  },
  clear: () => clearPick(),
  refresh: () => refreshStyles(),
  // Pick mode — the parent owns the flag (it routes the preview tap), and
  // this panel owns the side effects (a stale selection is dropped when the
  // mode is armed, the highlight is dropped when it is disarmed). The header
  // button asks through this handle so there is one implementation of the
  // flip rather than a second one that only remembered to set the flag.
  togglePick: () => togglePickMode()
};
return () => { if (props.panelHandlesRef) props.panelHandlesRef.current = null; };
});
// togglePickMode — switch "pick mode" on or off. When on, tapping the
// live preview selects an element (routed via the parent's stylesActive,
// which also drives the banner PreviewPanel renders over the screenshot).
// The parent owns the flag because it owns the tap routing; we just request
// the flip here, and the parent disarms it after a successful pick.
function togglePickMode() {
if (!props.onPickModeChange) return;
const next = !props.pickMode;
props.onPickModeChange(next);
// Turning pick mode on clears any stale selection so the tap lands on
// a fresh element; turning it off hides the highlight.
if (next) {
modelRef.current = null;
setModel(null);
setShot(null);
setTree(null);
setRules(null);
treeSerial.current++;
rulesSerial.current++;
setError('');
} else if (props.hideNodeHighlight) {
props.hideNodeHighlight().catch(() => {});
}
}

// setModelBoth — write the model and the ref together.
//
// `modelRef` is what the paths that run *after* a write read: applyEdit takes the
// value an undo has to restore from it, and markWritten asks it which names the
// edit actually wrote. Both used to read a list that had not changed since the
// element was picked, so a shorthand applied to an element with no inline styles
// marked nothing (the longhands were not in the stale list) and a re-edit of a
// property could record an empty "was". Updating both keeps "the model" and "the
// model the ref points at" the same thing, which is the invariant the rest of the
// panel already assumes.
function setModelBoth(next) {
modelRef.current = next;
setModel(next);
}
// Rebuild the inline-props list to reflect an edit we just applied. The
// parent holds the authoritative objectId; here we simply merge the new
// value into the existing list (or add it), and bump a `rev` so the key
// changes and Preact re-renders the row.
function upsertLocal(prop, value, priority) {
const prev = modelRef.current;
if (!prev) return;
let found = false;
const list = (prev.inlineProps || []).map((x) => {
if (x.prop === prop) { found = true; return { prop, value, priority: priority || '' }; }
return x;
});
if (!found) list.push({ prop, value, priority: priority || '' });
setModelBoth({ ...prev, inlineProps: list, rev: (prev.rev || 0) + 1 });
}
// changedNamesFor — the property names an edit of `prop` wrote, as the
// *element* reports them: the typed property plus every declaration of the
// element's own style that the write created (see writtenNames in shorthand.js).
//
// The page is the authority here on purpose. `padding: 30px` is stored by the
// CSSOM as `padding-top/right/bottom/left`, and a shorthand is never a row in
// either list — the computed list cannot even enumerate one — so an edit
// tracked by the typed name alone highlighted and hoisted nothing. Reading the
// names back means only declarations that really exist are marked, and an edit
// that expanded differently than expected still highlights what it wrote.
function changedNamesFor(prop) {
const rows = (modelRef.current && modelRef.current.inlineProps) || [];
return writtenNames(prop, rows.map((x) => x && x.prop));
}
// markWritten — record an edit in the changed set. Called after the post-edit
// read so the expansion above is the one the page produced.
function markWritten(prop) {
const names = changedNamesFor(prop);
setChanged((prev) => {
// Reversed so the property the user actually edited ends up first (markChanged
// unshifts), with the longhands it wrote following it.
let next = prev;
for (const name of names.slice().reverse()) next = markChanged(next, name);
return next;
});
}

// applyInlineSnapshot — fold readElementStyles' answer back into the model.
// The page is authoritative for the element's own inline style: rows come
// back CSSOM-normalised (so `margin: 40px` shows as the longhands the engine
// actually stored, and `#ffe600` as `rgb(255, 230, 0)`), and a property that
// no longer exists on the element simply disappears. The resolved values for
// those same properties are merged into the Computed list, which is what
// keeps a hoisted "changed" computed row from displaying the previous value.
function applyInlineSnapshot(snapshot) {
if (!snapshot || !snapshot.inline) return;
const inline = snapshot.inline || {};
const priorities = snapshot.priorities || {};
const resolved = snapshot.computed || {};
// The base font sizes come back on the same answer (see events.js
// readElementStyles). They are what makes the value-type switch's rem/em and
// font-size percentage conversions real numbers instead of an assumed 16px, so
// they are kept on the model and handed to the edit sheet as its unit context.
const bases = snapshot.bases || null;
const prev = modelRef.current;
if (!prev) return;
const inlineProps = Object.keys(inline).map((prop) => ({
prop,
value: String(inline[prop] || ''),
// The priority the element stores, read back with the value. Without it a
// property the user made `!important` came back looking normal the moment
// anything re-read the page, and the next edit silently dropped the priority.
priority: priorities[prop] === 'important' ? 'important' : ''
}));
const computed = (prev.computed || []).map((row) => (
Object.prototype.hasOwnProperty.call(resolved, row.prop)
? { ...row, value: String(resolved[row.prop] || '') }
: row
));
setModelBoth({ ...prev, inlineProps, computed, bases: bases || prev.bases || null, rev: (prev.rev || 0) + 1 });
}
// syncFromPage — pull the element's styles after an edit. Best-effort: a
// failed read leaves the model alone rather than blanking the lists.
async function syncFromPage() {
const objId = modelRef.current && modelRef.current.objectId;
if (!objId || !props.readElementStyles) return;
try {
applyInlineSnapshot(await props.readElementStyles(objId));
} catch { /* leave the model as-is */ }
}
// revalidate — re-read everything a write (or an undo) can invalidate. The
// inline list is not the only thing that goes stale: the matched-rules read
// carries the element's own `element.style` entry, which is what the target
// bar's origin sentence is computed from. Re-reading only the inline styles
// left that sentence claiming a value the element no longer has, which is the
// one thing the bar exists to get right.
async function revalidate() {
await syncFromPage();
const objId = modelRef.current && modelRef.current.objectId;
if (objId) await loadRules({ objectId: objId });
}

async function applyEdit(prop, value, priority) {
if (!props.setInlineStyleProperty) throw new Error('not connected');
const objId = modelRef.current && modelRef.current.objectId;
if (!objId) throw new Error('element not resolved');
// Read the value this property has *now*, before the write: that is what an
// undo of this change has to restore. recordChange keeps the earliest value for
// a property, so a chain of edits on one property still undoes to the original.
const prevRow = ((modelRef.current && modelRef.current.inlineProps) || [])
.filter((x) => x.prop === prop)[0];
const prevValue = (prevRow && prevRow.value) || '';
const prevPriority = (prevRow && prevRow.priority) || '';
// The engine's answer, not the argument: the write reads the priority back off
// the element (see setInlineStyleProperty), so what the receipt records and what
// the row shows is what is really stored.
const out = await props.setInlineStyleProperty(objId, prop, value, priority);
const applied = (out && out.priority) || '';
// Record the change ABOVE the panels (see the Inspector's recordReceipt): the
// entry has to outlive this panel's mount so the target bar can still undo it
// after the panel is switched off. The priority travels with it so an undo
// restores the declaration's priority as well as its value.
if (props.onRecordChange) {
props.onRecordChange({ prop, from: prevValue, to: value, fromPriority: prevPriority, toPriority: applied });
}
upsertLocal(prop, value, applied);
// Re-read the page so both lists show the value that was just applied (the
// Computed list is otherwise a snapshot that goes stale after an edit, and a
// hoisted "changed" row showing the old value is worse than no highlight), and
// so the target bar's origin sentence describes the declaration that now
// exists — a shorthand is expanded by the CSSOM, so its rules entry has to be
// re-read for the bar to find it.
await revalidate();
// Record the edit so its rows are hoisted + highlighted — after the read, not
// before it, because what has to be marked is what the page *wrote*. The CSSOM
// expands `padding: 30px` into four longhands and those are the rows both lists
// carry, so marking the typed name alone highlighted nothing at all (see
// writtenNames). Only names the element really has are marked.
markWritten(prop);
// Re-capture the pinned preview so the edit is visible in the panel and
// in the still-open edit sheet.
captureShot();
}
// applyControl — the touch surface's write path. A thin wrapper around applyEdit,
// for one reason: a control reports a failure in the panel's own error line
// instead of as an unhandled rejection. The write itself is unchanged, so a
// slider release and a typed Apply produce the same receipt entry, the same
// changed-first highlight and the same undo.
async function applyControl(prop, value) {
try {
await applyEdit(prop, value);
} catch (e) {
setError((e && e.message) || ('Could not set ' + prop));
}
}
async function removeEdit(prop) {
if (!props.removeInlineStyleProperty) throw new Error('not connected');
const objId = modelRef.current && modelRef.current.objectId;
if (!objId) throw new Error('element not resolved');
// A removal is a change too, and the value it dropped is what undo restores —
// along with the priority it was stored with, so undoing a removal of an
// `!important` declaration brings the priority back with the value.
const prevRow = ((modelRef.current && modelRef.current.inlineProps) || [])
.filter((x) => x.prop === prop)[0];
const prevValue = (prevRow && prevRow.value) || '';
const prevPriority = (prevRow && prevRow.priority) || '';
// What this removal takes off the element: read before the write, since the
// longhands a shorthand wrote are gone from the style the moment it is removed.
const written = changedNamesFor(prop);
await props.removeInlineStyleProperty(objId, prop);
if (props.onRecordChange) props.onRecordChange({ prop, from: prevValue, to: '', fromPriority: prevPriority, toPriority: '' });
// Drop the row entirely so the property returns to its inherited state.
if (modelRef.current) {
setModelBoth({ ...modelRef.current, inlineProps: modelRef.current.inlineProps.filter((x) => x.prop !== prop), rev: (modelRef.current.rev || 0) + 1 });
}
// Nothing left to highlight for a property that no longer exists here — nor
// for the longhands it took with it.
setChanged((prev) => written.reduce((acc, name) => unmarkChanged(acc, name), prev));
// The property now resolves from a class / stylesheet, so its computed value
// changed too — and its `element.style` rule entry is gone, which the bar's
// origin sentence reads.
await revalidate();
captureShot();
}
// The undo handlers left this panel with the receipt: the LIST is owned by the
// Inspector now (see its receipt state), which reverses entries against the
// objectId it retains, so an undo works while this panel is switched off. This
// panel only reports the result to its own highlight set, and re-reads the
// element when the parent says a change was reversed (receiptNonce).
function noteUndone(prop) {
// The receipt names the property the user edited; the highlight covers the
// longhands that edit wrote, so the whole group is dropped together.
const written = changedNamesFor(prop);
setChanged((prev) => written.reduce((acc, name) => unmarkChanged(acc, name), prev));
}
function refreshStyles() {
const objectId = modelRef.current && modelRef.current.objectId;
if (!objectId) return;
loadModel(() => props.refreshNodeModel(objectId));
}

function clearPick() {
// Mark the retained id as handled *before* dropping the model: with the model
// gone this panel is in the state the adopt effect looks for, and without the
// mark it re-reads the element the Inspector retained and the ✕ silently undoes
// itself (see adoptRestored above).
adoptedRef.current = props.restoreObjectId || adoptedRef.current;
modelRef.current = null;
shotSerial.current++;
treeSerial.current++;
rulesSerial.current++;
setModel(null);
setShot(null);
setShotBusy(false);
setTree(null);
setRules(null);
setEdit(null);
// The card sheet names a property to add *to this element*, so with no element
// there is nothing for it to add to.
setAddOpen(false);
setError('');
// The receipt describes edits made to the element that was selected, and the
// Inspector owns it: with no selection there is nothing to undo, so it is
// cleared there rather than here.
if (props.onSelectionReset) props.onSelectionReset();
// `onCleared` is the *clear* signal, not the new-selection one `onSelectionReset`
// also fires for: the Inspector retains the last non-empty snapshot (so the
// element's identity survives switching this panel off), and an explicit ✕ is
// the one event that has to drop it. Without this the panel header kept showing
// the element the user had just cleared.
if (props.onCleared) props.onCleared();
setChanged([]);
if (props.hideNodeHighlight) props.hideNodeHighlight().catch(() => {});
}
// Idle state — nothing selected yet. Prompts the user to tap the preview
// (if available) or type a selector.
if (!model) {
// Pick mode only works through the live preview, so when that panel is
// hidden the button is disabled rather than offering an action that cannot
// complete. `undefined` (an unwired prop) is treated as visible.
const previewHidden = props.previewVisible === false;
return h('div', { class: 'inspector__styles', role: 'group', 'aria-label': 'Element styles' },
h('div', { class: 'inspector__styles-empty', role: 'status' },
h('p', { class: 'inspector__styles-intro' }, 'Select an element to edit its inline CSS and read the result here.'),
props.pickMode
? h('p', { class: 'inspector__styles-or' },
previewHidden ? 'The Preview panel is hidden — use a selector below.' : 'Now tap the element in the live preview.')
: null,
h('button', {
class: 'inspector__styles-tap' + (props.pickMode ? ' is-on' : ''),
type: 'button',
'aria-pressed': String(!!props.pickMode),
disabled: previewHidden && !props.pickMode,
title: previewHidden && !props.pickMode
? 'Turn the Preview panel on to pick elements from the page'
: (props.pickMode ? 'Pick mode on — tap the preview to select' : 'Pick mode off — tap the preview to select'),
onClick: togglePickMode
}, h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M5 3l14 7-6.5 1.5L10 19 5 3Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round' })
),
h('span', null, props.pickMode ? 'Selecting…' : 'Tap element')
),
h('p', { class: 'inspector__styles-or' }, 'or type a selector'),
h('div', { class: 'inspector__styles-select' },
h('input', {
class: 'input inspector__styles-sel',
type: 'text',
value: selValue,
placeholder: '#hero, .card, button',
autocapitalize: 'off',
autocorrect: 'off',
spellcheck: false,
enterkeyhint: 'go',
onInput: (e) => setSelValue(e.currentTarget.value),
onKeydown: (e) => { if (e.key === 'Enter') pickBySelector(); }
}),
h('button', {
class: 'btn inspector__styles-sel-go',
type: 'button',
disabled: loading || !(selValue || '').trim(),
onClick: pickBySelector
}, loading ? '…' : 'Select')
),
error ? h('p', { class: 'inspector__style-error', role: 'alert' }, error) : null
)
);
}

const label = elementLabel(model.node);
// boxSize — the identity chip's second line. `cleanSize` drops the `— × —`
// a node with no measurable box produces (a display:none pickup, a detached
// node), because printing that next to the tag is noise pretending to be data.
const boxSize = cleanSize(boxSummary(model.box));
// unitCtx — the real base font sizes the touch surface's unit chips convert with
// (rem from the root, em and % from the parent), read once with the element's
// styles. Without them a `rem` chip would have to guess 16px, and the surface
// falls back to writing px instead (see toUnit).
const unitCtx = model.bases
? { rootFontSize: model.bases.root, parentFontSize: model.bases.parent, fontSize: model.bases.self }
: {};
const inlineRows = (model.inlineProps || []);
const computedRows = (model.computed || []);
// The value index: what values and tokens this page uses per property, built
// from the rules and the computed style already in hand (see valueIndex.js).
// Memoised because the panel re-renders on every CDP event (a console row, a
// network response) while these two inputs change only on a selection or an
// edit — and the index walks ~400 computed rows each time it is built.
const valueIndex = useMemo(
  () => buildValueIndex({ rules: (rules && rules.rules) || [], computed: computedRows }),
  [rules, computedRows]
);
// Hoist the properties changed in this session to the top of both lists
// (most recent first) so the edit you just made is the first thing you see,
// rather than something to hunt for in the ~400-row computed wall.
const declaredRows = orderChangedFirst(inlineRows, changed);
const orderedComputed = orderChangedFirst(computedRows, changed);
// The Computed list, narrowed. `setNames` is what this element declares
// itself (its inline style plus anything edited in this session), which is
// the useful half of a computed wall that is otherwise mostly inherited and
// default values.
const setNames = new Set(inlineRows.map((x) => x.prop));
const changedNames = new Set(changed);
const computedVisible = filterComputed(orderedComputed, {
query: computedQuery,
filter: computedFilter,
setNames,
changedNames
});
const computedPageLimit = pageLimit(computedVisible.length, computedSteps);
const computedPage = computedVisible.slice(0, computedPageLimit);
const computedMore = moreRows(computedVisible.length, computedSteps);
computedMoreRef.current = computedMore;
return h('div', {
class: 'inspector__styles',
ref: panelRef,
role: 'group',
'aria-label': 'Element styles',
onScroll: onPanelScroll
},
// Sticky block: the selected element's identity and the pinned preview stay
// at the top of the panel's scroller while the property list below scrolls.
// Without this the read-out of the edit's result scrolled away as soon as
// the user reached the "Declared styles" rows.
//
// The **actions** (clear, refresh, pick) are not here: they moved up into the
// card header (Inspector.jsx PanelCard), next to the panel's eye, exactly
// where the other panels keep their own controls. That leaves this row to the
// element's identity — `tag#id.class` plus its box size — which is what the
// row was crowding: three labelled buttons (Clear / Refresh / Pick) on a
// 360 px screen left the identity about 100 px and it ellipsized first, in the
// row the user reads to answer "what am I editing?". One row wide it is
// untruncated, and it is still a button: tapping it copies the selector
// (props.onCopyElement reports the outcome in the status pill above the
// panels), so the label is also how it leaves the inspector.
h('div', { class: 'inspector__styles-pin' },
h('button', {
class: 'inspector__styles-elem',
type: 'button',
title: 'Copy the selector ' + label + (boxSize ? ' · ' + boxSize : ''),
'aria-label': 'Copy selector ' + label,
onClick: () => { if (props.onCopyElement) props.onCopyElement(label); }
},
h('span', { class: 'inspector__styles-elem-name' }, label),
boxSize ? h('span', { class: 'inspector__styles-elem-size' }, boxSize) : null
),
// The error line belongs *inside* the sticky block, with the element it is
// about. The tree steps (selectAncestor / selectChild) and a failed selector
// both report through here, and they are exactly the actions that can land the
// user scrolled deep into the panel — where an error rendered below the pinned
// block was off screen, so a failed "go to parent" looked like a tap that did
// nothing. No error, no row: the block keeps its height when there is nothing
// wrong.
error
? h('p', { class: 'inspector__style-error', role: 'alert' }, error)
: null,
// Pinned element preview: a clipped screenshot of the selected element, so
// the result of an edit is readable without scrolling back to the Preview
// panel. Hidden until the first capture lands.
//
// The "tap to refresh" hint is a caption *under* the image, not a label on
// top of it. Drawn over the capture it sat on whatever the element happened
// to render in that corner — on a page of body text it landed on the text —
// and a 56 px strip of an element is exactly where the user is trying to read
// small type. The caption also carries the "Updating…" state, so the strip
// never changes height and the list below never shifts.
shot
? h('div', { class: 'inspector__styles-shotwrap' },
h('button', {
class: 'inspector__styles-shot',
type: 'button',
title: 'Tap to refresh the element preview',
'aria-label': 'Refresh the element preview for ' + label,
disabled: shotBusy,
onClick: captureShot
},
h('img', {
class: 'inspector__styles-shot-img',
src: shot.src,
alt: 'Preview of ' + label,
draggable: 'false'
})
),
h('p', { class: 'inspector__styles-shot-note', role: 'status' },
h('span', null, shotBusy ? 'Updating…' : 'Live element preview — tap to refresh'),
h('span', { class: 'inspector__styles-shot-dims' },
shot.width && shot.height ? shot.width + '×' + shot.height : '')
)
)
: null
),
// Element tree — the selected element's ancestors as a breadcrumb and its
// direct children as chips, so the DOM can be walked without going back to
// the live preview to tap again. One tap on `main` or `body` beats
// re-picking a possibly overlapping element on a 360 px screenshot.
//
// The receipt strip sits first in the scroll flow, above the tree and the
// property lists: it answers "what did I change, and can I get back?" — which is
// the question immediately after an edit, and the one the "changed" chip alone
// cannot answer. It renders nothing when there is nothing to undo.
h(Receipt, {
receipt,
busy: false,
onUndo: (row) => { noteUndone(row.prop); if (props.onUndo) props.onUndo(row); },
onUndoAll: () => { setChanged([]); if (props.onUndoAll) props.onUndoAll(); },
// Tapping a changed value reopens its editor on the value that is on the
// page now, so the strip at the top of the panel is also the shortest way
// back to the property that was just changed.
onEditRow: (row) => setEdit({ prop: row.prop, value: row.to })
}),
// Deliberately *inside the scroll flow*, not in the sticky block above it.
// Both strips are horizontal scrollers a full tap-target tall, and pinning
// them cost ~80 px of the 352 px scroller on a 360 × 680 phone — about two
// property rows, for a navigation affordance that is used deliberately and
// rarely. Reading values is what happens constantly, so the pin carries only
// the element header and the preview, and the tree scrolls away behind it.
// The element label in the header keeps "what is selected" on screen at all
// times; this section answers "what is it inside of".
(tree && ((tree.ancestors && tree.ancestors.length) || (tree.children && tree.children.length)))
? h('div', { class: 'inspector__styles-section' },
h('h3', { class: 'inspector__styles-h' }, 'Element tree'),
// Parents — one labelled row ("↑ Parents") with a chevron between the
// crumbs, so the row reads as the path `html › body › div#app` instead of
// as a set of equal chips whose order the user has to work out. The last
// chip is the selected element: it is not a tap target, so it is a static
// accent chip rather than a button.
//
// It is *one line*, label included, and the chip strip inside it scrolls
// sideways instead of wrapping (see .inspector__styles-tree-row--parents): a
// deep element used to wrap into three or four 44 px lines of pills, which
// pushed the property rows it is meant to introduce out of the panel. The strip
// is auto-scrolled to its end, so the chip that answers "where am I" is on
// screen. Child chips below still wrap — they are a disclosure the user opens on
// purpose, and a browsing aid rather than a path.
tree.ancestors && tree.ancestors.length
? h('div', { class: 'inspector__styles-tree-row inspector__styles-tree-row--parents' },
h('span', { class: 'inspector__styles-tree-label' },
h('span', { class: 'inspector__styles-tree-arrow', 'aria-hidden': 'true' }, '↑'),
'Parents'
),
h('div', { class: 'inspector__styles-crumbs', ref: crumbsRef, role: 'group', 'aria-label': 'Parent elements, root first' },
tree.ancestors.slice().reverse().reduce((nodes, a) => nodes.concat([
h('button', {
class: 'inspector__styles-crumb',
type: 'button',
key: 'anc-' + a.levels,
title: 'Select ' + a.label,
'aria-label': 'Select parent element ' + a.label,
onClick: () => selectAncestor(a.levels)
},
h('span', { class: 'inspector__styles-crumb-label' }, a.label)
),
h('span', { class: 'inspector__styles-crumb-sep', 'aria-hidden': 'true', key: 'sep-' + a.levels }, '›')
]), []).concat([
h('span', { class: 'inspector__styles-crumb is-here', key: 'here' },
h('span', { class: 'inspector__styles-crumb-label' }, label)
)
]))
)
: null,
// Children — a labelled disclosure ("▸ Children 13") with its chips in
// their own wrapped row below it. The chips are collapsed by default;
// separating the label from the chips keeps "go up" and "go down" from
// looking like one undifferentiated list of pills.
tree.children && tree.children.length
? h('div', { class: 'inspector__styles-tree-row' },
h('button', {
class: 'inspector__styles-kids-toggle',
type: 'button',
'aria-expanded': String(kidsOpen),
'aria-label': (kidsOpen ? 'Hide' : 'Show') + ' the ' + tree.childCount + ' child element'
+ (tree.childCount === 1 ? '' : 's') + ' of ' + label,
title: kidsOpen ? 'Hide children' : 'Show children',
onClick: () => setKidsOpen(!kidsOpen)
},
h('span', { class: 'inspector__styles-kids-caret', 'aria-hidden': 'true' }, kidsOpen ? '▾' : '▸'),
h('span', { class: 'inspector__styles-tree-arrow', 'aria-hidden': 'true' }, '↓'),
h('span', { class: 'inspector__styles-kids-label' }, 'Children'),
h('span', { class: 'inspector__styles-kids-n', 'aria-hidden': 'true' }, String(tree.childCount))
),
kidsOpen
? h('div', { class: 'inspector__styles-kids', role: 'group', 'aria-label': 'Child elements' },
tree.children.map((c, i) => h('button', {
class: 'inspector__styles-kid',
type: 'button',
key: 'kid-' + i,
title: 'Select ' + c.label,
'aria-label': 'Select child element ' + c.label,
onClick: () => selectChild(i)
},
// The label needs its own element to ellipsize: `text-overflow` does not
// apply to the anonymous flex item a bare text child becomes, so the text
// overflowed the chip's rounded border instead of being clipped.
h('span', { class: 'inspector__styles-kid-label' }, c.label)
)),
tree.childCount > tree.children.length
? h('span', { class: 'inspector__styles-kids-more' }, '+' + (tree.childCount - tree.children.length) + ' more')
: null
)
: null
)
: null
)
: null,
// Touch-first control surface. Everything below this section can write any
// property, but only with a keyboard: the rows here are the properties a phone
// user actually reaches for, as chips, sliders, a box model and swatches (see
// StyleControls.jsx). It sits above "Declared styles" because it is the *first*
// answer to "change this element" — the declared list is the exhaustive one, kept
// for anything the surface does not name, and both write through applyEdit, so a
// slider release and a typed value produce the same receipt entry and the same
// undo.
h('div', { class: 'inspector__styles-section' },
h('h3', { class: 'inspector__styles-h' }, 'Style controls'),
h(StyleControls, {
// Keyed by element: a new selection remounts the surface, which is what resets
// its group tab to what the new element needs and its box-model edge to the
// padding top (see defaultGroup).
key: 'touch-' + ((model && model.objectId) || 'none'),
ctx: { declared: inlineRows, computed: computedRows },
unitCtx,
label,
// The colours this page already uses for a property, one tap away — the panel's
// value index answers it, so the swatches cost no page read.
swatchesFor: (prop) => valuesFor(valueIndex, prop, 6).map((r) => r.value),
onApply: applyControl,
// The value button and the colour swatch open the same editor a declared row
// opens: exact typing, the value-type switch, the unit row and the page's own
// suggestions live there, and no touch control replaces them.
onEdit: (prop, value) => setEdit({ prop, value }),
onAddProperty: () => setAddOpen(true),
disabled: loading,
// The panel scrolls the chip row back into view when the group changes; the
// surface publishes the row and its own post-render reveal (see revealRef).
tabsRef,
revealRef,
onGroupChange: setTouchGroup
})
),
h('div', { class: 'inspector__styles-section' },
h('h3', { class: 'inspector__styles-h' }, 'Declared styles'),
inlineRows.length
? h('ul', { class: 'inspector__styles-list' },
declaredRows.map((row) => h('li', {
class: 'inspector__styles-row inspector__styles-row--declared'
+ (isChanged(changed, row.prop) ? ' inspector__styles-row--changed' : ''),
key: (model.rev || 0) + ':' + row.prop
},
h('button', {
class: 'inspector__styles-row-main',
type: 'button',
// Accessible name must contain the visible text (WCAG 2.5.3 Label in
// Name): the row visibly shows `{prop} {value}`, so echo both in the
// label alongside the edit action — a bare "Edit color" would fail the
// label-content-name-mismatch check and be confusing for screen-reader
// users who see "color #00ff00" on screen. Changed rows also announce
// that state, since the highlight is colour-only for sighted users.
'aria-label': (isChanged(changed, row.prop) ? 'Changed. ' : '')
+ (row.value ? 'Edit ' + row.prop + ', value ' + row.value : 'Edit ' + row.prop),
title: 'Edit ' + row.prop,
onClick: () => setEdit({ prop: row.prop, value: row.value, priority: row.priority || '' })
},
h('span', { class: 'inspector__styles-prop' }, row.prop),
isChanged(changed, row.prop) ? h('span', { class: 'inspector__styles-changed', 'aria-hidden': 'true' }, 'changed') : null,
// A declaration the element stores as `!important` says so on the row. It is a
// different thing from a normal one — it beats later normal declarations and
// every stylesheet rule except another `!important` — so hiding it would leave
// the user unable to explain the cascade, and unable to tell which of their own
// edits is carrying priority.
row.priority === 'important'
? h('span', { class: 'inspector__styles-important', title: 'Stored as !important on this element' }, '!important')
: null,
valueSwatch(row.prop, row.value),
h('span', { class: 'inspector__styles-val' }, row.value || '')
)
))
)
: h('p', { class: 'inspector__styles-none' }, 'No inline styles yet.', h('br'), 'Tap Add property above to set one.')
),
h('div', { class: 'inspector__styles-section' },
h(MatchedRulesSection, {
rules: rules ? rules.rules : null,
counts: rules ? rules.counts : null,
truncated: rules ? rules.truncated : 0,
busy: rulesBusy,
open: rulesOpen,
showUa,
// Which element the cascade belongs to. The section re-seeds its
// per-rule open state from this, because the same rule ids come back for a
// different element and the previous element's open rules would be wrong.
selectionKey: model.objectId,
onToggle: () => setRulesOpen(!rulesOpen),
onToggleUa: () => setShowUa(!showUa),
onEdit: (prop, value) => setEdit({ prop, value })
})
),
h('div', { class: 'inspector__styles-section' },
h('div', { class: 'inspector__computed-bar' },
h('h3', { class: 'inspector__styles-h' }, 'Computed'),
h('span', { class: 'inspector__computed-count' }, computedVisible.length + '/' + computedRows.length),
// "Show" turns three chips into a filter, not a second set of tabs. Each
// chip also carries its meaning in the title / accessible name, and the
// status line under the search states the one in force in words.
//
// The label and the chips are one flex item, so they wrap together. As two
// siblings the label — pinned right by `margin-left: auto` — stayed on the
// first row at 360 px while the chips dropped to the next one, leaving a
// lone "SHOW" at the right edge with nothing beside it.
h('div', { class: 'inspector__computed-showgroup' },
h('span', { class: 'inspector__computed-show', 'aria-hidden': 'true' }, 'Show'),
h('div', { class: 'inspector__computed-filters', role: 'group', 'aria-label': 'Filter computed properties' },
FILTERS.map((f) => h('button', {
class: 'inspector__computed-filter' + (computedFilter === f.id ? ' is-on' : ''),
type: 'button',
key: f.id,
'aria-pressed': String(computedFilter === f.id),
title: 'Show ' + f.hint,
'aria-label': 'Show ' + f.hint,
onClick: () => setComputedFilterState(f.id)
}, f.label))
)
)
),
h('div', { class: 'inspector__computed-searchrow' },
h('input', {
class: 'input inspector__computed-search',
type: 'search',
value: computedQuery,
placeholder: 'Filter property or value…',
'aria-label': 'Filter computed properties by name or value',
autocapitalize: 'off',
autocorrect: 'off',
spellcheck: false,
onInput: (e) => setComputedQueryState(e.currentTarget.value)
}),
computedQuery
? h('button', {
class: 'inspector__computed-clear',
type: 'button',
'aria-label': 'Clear the computed filter',
title: 'Clear the computed filter',
onClick: () => setComputedQueryState('')
}, '✕')
: null
),
// What the list below actually holds, in one line: the active filter spelled
// out, and — when a search is on — how many rows matched out of the whole
// resolved set. Without this, "2/406" reads as a broken read rather than as
// the search the user just typed.
h('p', { class: 'inspector__computed-status', role: 'status' },
statusLine({
filter: computedFilter,
shown: computedVisible.length,
total: computedRows.length,
query: computedQuery
})
),
computedVisible.length
? [
h('ul', { class: 'inspector__styles-list inspector__styles-list--computed', key: 'list' },
computedPage.map((row) => {
// The computed list is read-only by design — it is a ~400-row read-out, and a
// tap target on every row would be 17 000 px of scrolling. A *changed* row is
// the exception: there are only a handful, they are hoisted to the top, and the
// row is the answer to "I just changed this — what is it now, and let me change
// it again?". So it carries the same editor button a declared row does, with
// the value the page reports now, which is also the shortest path into the
// value sheet's type switch, unit chips and rail.
const changedRow = isChanged(changed, row.prop);
const cells = [
h('span', { class: 'inspector__styles-prop' }, row.prop),
changedRow ? h('span', { class: 'inspector__styles-changed', 'aria-hidden': 'true' }, 'changed') : null,
valueSwatch(row.prop, row.value),
h('span', { class: 'inspector__styles-val' }, row.value || '')
];
return h('li', {
class: 'inspector__styles-row inspector__styles-row--computed'
+ (changedRow ? ' inspector__styles-row--changed' : ''),
key: row.prop
},
changedRow
? h('button', {
class: 'inspector__styles-row-main',
type: 'button',
// Same label-in-name rule as a declared row: the row visibly reads
// `{prop} {value}`, so the accessible name echoes both — plus the
// changed state, which is colour-only for sighted users.
'aria-label': 'Changed. Edit ' + row.prop + ', value ' + (row.value || ''),
title: 'Edit ' + row.prop,
onClick: () => setEdit({ prop: row.prop, value: row.value })
}, cells)
: cells
);
})
),
computedMore > 0
? h('button', {
class: 'inspector__computed-more',
type: 'button',
key: 'more',
onClick: () => setComputedSteps(computedSteps + 1)
}, 'Show ' + Math.min(COMPUTED_PAGE, computedMore) + ' more of ' + computedVisible.length)
: (computedSteps > 0
? h('button', {
class: 'inspector__computed-more',
type: 'button',
key: 'less',
onClick: () => setComputedSteps(0)
}, 'Collapse to the first ' + Math.min(COMPUTED_PAGE, computedVisible.length))
: null)
]
: h('p', { class: 'inspector__styles-none', role: 'status' },
emptyMessage({ query: computedQuery, filter: computedFilter }))
),
edit ? h(StyleEditSheet, {
// Keyed by property so a different row remounts the sheet: its own value state,
// its colour format and its sticky shape all reset together, rather than leaking
// between two different edits.
key: 'sheet-' + edit.prop,
prop: edit.prop,
value: edit.value,
// The priority the element stores for this property right now, so the sheet's
// `!important` toggle opens on the truth and an edit keeps it.
priority: edit.priority || '',
isInline: true,
isRemove: inlineRows.some((x) => x.prop === edit.prop),
// The element's own box, for the value rail's length range (0…4× its size).
box: model.box,
// What the element declares right now, so the sheet can count what the write
// keeps as well as what it changes (see scopeSummary).
declared: inlineRows,
valueIndex,
// The colours this page uses for the property being edited: the colour view's
// palette. It comes from the index the panel already built, so it costs no page
// read. The keyword list is derived inside the sheet from the live property.
colourCandidates: valuesFor(valueIndex, edit.prop, 8),
// The value the property had before this session's first edit on it: the rail's
// header prints it struck through, so a drag always shows what it replaced.
from: (() => {
const entry = (props.receipt || []).find((r) => r.prop === edit.prop);
return entry ? entry.from : null;
})(),
shot: shot && shot.src,
shotBusy,
// The real base font sizes (root for rem, parent for em / font-size %) so the
// value-type switch converts with numbers instead of assuming 16px.
unitCtx: model.bases ? { rootFontSize: model.bases.root, parentFontSize: model.bases.parent, fontSize: model.bases.self } : undefined,
// The element's resolved background and text colours: what a colour chip's
// WCAG ratio is measured against (see contrast.js). Read from the computed
// list the panel already has, so the badge costs no extra CDP call.
contrastCtx: (() => {
  const resolved = (name) => {
    const row = computedRows.find((r) => r.prop === name);
    return row ? row.value : '';
  };
  const bg = resolved('background-color');
  return {
    bg,
    color: resolved('color'),
    // A transparent background has nothing to measure against, so the ratio
    // is read against the page's own background instead of against `rgba(0,0,0,0)`.
    fallbackBg: /rgba?\(0,\s*0,\s*0,\s*0\)|transparent/i.test(bg) ? resolved('background-color') : ''
  };
})(),
onRefreshShot: captureShot,
// The sibling read the sheet's Match-a-sibling group uses: bound to the
// selected element's objectId here, so the sheet only has to name a property.
readSiblings: props.readSiblingValues && model.objectId
? (property) => props.readSiblingValues(model.objectId, property)
: null,
onApply: applyEdit,
onRemove: removeEdit,
onDone: () => setEdit(null),
onCancel: () => setEdit(null)
}) : null,
// The card sheet that chooses *which* property to edit. Rendered from the same
// panel state as the editor, so picking a card closes one sheet and opens the
// other in a single render — there is no frame in which neither is up, which is
// what makes the browse → set-value hand-off feel like one motion.
h(AddPropertySheet, {
open: addOpen,
ctx: { declared: inlineRows, computed: computedRows },
suggestions: COMMON_CSS,
onClose: () => setAddOpen(false),
onPick: (row) => {
setAddOpen(false);
setEdit({ prop: row.prop, value: row.isSet ? row.value : '' });
}
})
);
}
