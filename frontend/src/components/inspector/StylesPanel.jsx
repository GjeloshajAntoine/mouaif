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
import { useRef, useState, useEffect } from 'preact/hooks';
import { markChanged, unmarkChanged, orderChangedFirst, isChanged } from './stylesOrder.js';

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

// COMMON_CSS — a short list of commonly-edited properties shown as quick
// "add a property" chips. Tapping one opens the editor with that property
// pre-filled. Kept intentionally small; the user can type any property in
// the editor's property field.
const COMMON_CSS = [
['color', 'text color'],
['background-color', 'background'],
['font-size', 'font size'],
['margin', 'margin'],
['padding', 'padding'],
['border', 'border']
];

// STEP_RE — a value the −/+ steppers can nudge: a number with an optional
// unit. Deliberately narrow (`px`, `%`, `rem`, …) so the steppers only show
// up for lengths and unitless numbers — never for colors, keywords, or
// multi-part shorthands where "+1" would be meaningless.
const STEP_RE = /^(-?\d+(?:\.\d+)?)(px|em|rem|%|vh|vw|pt|ch|ex)?$/;
// stepValue — the value one step up or down, or null when the current value
// isn't steppable. Negative results clamp at 0 rather than producing an
// invalid `-4px` for a padding.
function stepValue(value, dir) {
const m = STEP_RE.exec(String(value == null ? '' : value).trim());
if (!m) return null;
const next = parseFloat(m[1]) + dir;
if (!Number.isFinite(next)) return null;
const n = next < 0 ? 0 : next;
return String(Number(n.toFixed(2))) + (m[2] || '');
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
const [value, setValue] = useState(props.value || '');
const [busy, setBusy] = useState(false);
const [error, setError] = useState('');
const [applied, setApplied] = useState(false);
// Guards every post-await setState: the sheet unmounts on Done/Cancel while
// an apply is still in flight.
const alive = useRef(true);
useEffect(() => () => { alive.current = false; }, []);
// When the sheet opens for a different row / chip, reset the field. A
// `key` on the caller side also does this; resetting here makes the
// component self-contained regardless of how it's mounted.
useEffect(() => {
setProp(props.prop || '');
setValue(props.value || '');
setError('');
setApplied(false);
}, [props.prop, props.value]);
const propName = (prop || '').trim();
const down = stepValue(value, -1);
const up = stepValue(value, 1);
async function commit(p, v) {
if (busy || !props.onApply) return;
setBusy(true);
setError('');
try {
await props.onApply(p, v);
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
if (!propName) { setError('Property is required.'); return; }
const v = (value || '').trim();
// An empty value is not a no-op: `style.setProperty(p, '')` drops the
// declaration, so "Apply" with a blank field would silently unset the
// property the user came here to change. Removal is explicit (Remove).
if (!v) { setError('Value is required — use Remove to drop the property.'); return; }
await commit(propName, v);
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
return h('div', { class: 'inspector__overlay', onClick: busy ? undefined : props.onCancel },
h('div', {
class: 'inspector__sheet inspector__sheet--style',
role: 'dialog',
'aria-modal': 'true',
'aria-label': 'Edit ' + (propName || 'style'),
onClick: (e) => e.stopPropagation()
},
h('div', { class: 'inspector__sheet-head' },
h('strong', { class: 'inspector__sheet-title' }, propName ? 'Edit ' + propName : 'Add style'),
h('button', { class: 'btn inspector__sheet-close', type: 'button', onClick: props.onCancel }, applied ? 'Done' : 'Cancel')
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
spellcheck: 'false',
onInput: (e) => { setProp(e.currentTarget.value); setApplied(false); }
}),
h('label', { class: 'label' }, 'Value'),
h('div', { class: 'inspector__style-valuerow' },
h('button', {
class: 'inspector__style-step',
type: 'button',
disabled: busy || down == null,
'aria-label': 'Decrease ' + (propName || 'value'),
title: down == null ? 'Not a number' : 'Decrease to ' + down,
onClick: () => nudge(down)
}, '−'),
h('input', {
class: 'input inspector__style-input inspector__style-input--value',
type: 'text',
value,
placeholder: 'e.g. #ffcc00',
autocapitalize: 'off',
autocorrect: 'off',
spellcheck: 'false',
onInput: (e) => { setValue(e.currentTarget.value); setApplied(false); }
}),
h('button', {
class: 'inspector__style-step',
type: 'button',
disabled: busy || up == null,
'aria-label': 'Increase ' + (propName || 'value'),
title: up == null ? 'Not a number' : 'Increase to ' + up,
onClick: () => nudge(up)
}, '+')
),
props.isInline ? h('p', { class: 'inspector__style-hint' }, 'This sets the element’s own inline style') : null,
applied ? h('p', { class: 'inspector__style-applied', role: 'status' }, 'Applied — keep editing or tap Done') : null,
error ? h('p', { class: 'inspector__style-error', role: 'alert' }, error) : null,
h('div', { class: 'inspector__sheet-actions' },
h('button', {
class: 'btn inspector__style-apply',
type: 'button',
disabled: busy || !propName || !(value || '').trim(),
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
)
)
);
}

// StylesPanel — the whole "Styles" tab body.
export function StylesPanel(props) {
const [model, setModel] = useState(null);
const [loading, setLoading] = useState(false);
const [error, setError] = useState('');
const [edit, setEdit] = useState(null); // { prop, value } when editing
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
const crumbRef = useRef(null);
// shotSerial — only the newest capture may write to state. Picks, applies,
// and manual refreshes can overlap, and a slow capture for a previously
// selected element must not replace the current element's preview.
const shotSerial = useRef(0);
// captureShot — grab a clipped screenshot of the currently selected
// element. Never throws: a failed capture leaves the previous preview in
// place rather than blanking the panel.
async function captureShot() {
const objectId = modelRef.current && modelRef.current.objectId;
if (!objectId || !props.captureElementShot) return;
const serial = ++shotSerial.current;
setShotBusy(true);
try {
const r = await props.captureElementShot(objectId);
if (serial !== shotSerial.current) return;
if (r && r.data) {
setShot({ src: 'data:image/png;base64,' + r.data, width: r.width, height: r.height });
}
} catch { /* keep the previous preview */ } finally {
if (serial === shotSerial.current) setShotBusy(false);
}
}
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
if (!m || m.objectId !== prevId) setChanged([]);
modelRef.current = m;
setModel(m);
shotSerial.current++;
setShot(null);
setShotBusy(false);
captureShot();
loadTree(m);
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
if (!props.pickNodeAt) return;
setError('');
try {
const m = await props.pickNodeAt(x, y);
if (m) applyModel(m);
else setError('Nothing selectable at that point.');
} catch (e) {
setError((e && e.message) || 'Inspect failed');
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
// togglePickMode — switch "pick mode" on or off. When on, tapping the
// live preview selects an element (routed via the parent's stylesActive).
// The parent owns the flag (styled in the Preview header) so the two
// panels stay in sync; we just request the flip here.
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
treeSerial.current++;
setError('');
} else if (props.hideNodeHighlight) {
props.hideNodeHighlight().catch(() => {});
}
}

// Rebuild the inline-props list to reflect an edit we just applied. The
// parent holds the authoritative objectId; here we simply merge the new
// value into the existing list (or add it), and bump a `rev` so the key
// changes and Preact re-renders the row.
function upsertLocal(prop, value) {
setModel((prev) => {
if (!prev) return prev;
let found = false;
const list = prev.inlineProps.map((x) => {
if (x.prop === prop) { found = true; return { prop, value }; }
return x;
});
if (!found) list.push({ prop, value });
return { ...prev, inlineProps: list, rev: (prev.rev || 0) + 1 };
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
const resolved = snapshot.computed || {};
setModel((prev) => {
if (!prev) return prev;
const inlineProps = Object.keys(inline).map((prop) => ({ prop, value: String(inline[prop] || '') }));
const computed = (prev.computed || []).map((row) => (
Object.prototype.hasOwnProperty.call(resolved, row.prop)
? { ...row, value: String(resolved[row.prop] || '') }
: row
));
return { ...prev, inlineProps, computed, rev: (prev.rev || 0) + 1 };
});
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

async function applyEdit(prop, value) {
if (!props.setInlineStyleProperty) throw new Error('not connected');
const objId = modelRef.current && modelRef.current.objectId;
if (!objId) throw new Error('element not resolved');
await props.setInlineStyleProperty(objId, prop, value);
upsertLocal(prop, value);
// Record the edit so the row is hoisted + highlighted from here on.
setChanged((prev) => markChanged(prev, prop));
// Re-read the page so both lists show the value that was just applied (the
// Computed list is otherwise a snapshot that goes stale after an edit, and a
// hoisted "changed" row showing the old value is worse than no highlight).
await syncFromPage();
// Re-capture the pinned preview so the edit is visible in the panel and
// in the still-open edit sheet.
captureShot();
}
async function removeEdit(prop) {
if (!props.removeInlineStyleProperty) throw new Error('not connected');
const objId = modelRef.current && modelRef.current.objectId;
if (!objId) throw new Error('element not resolved');
await props.removeInlineStyleProperty(objId, prop);
// Drop the row entirely so the property returns to its inherited state.
setModel((prev) => prev ? { ...prev, inlineProps: prev.inlineProps.filter((x) => x.prop !== prop), rev: (prev.rev || 0) + 1 } : prev);
// Nothing left to highlight for a property that no longer exists here.
setChanged((prev) => unmarkChanged(prev, prop));
// The property now resolves from a class / stylesheet, so its computed value
// changed too.
await syncFromPage();
captureShot();
}

function refreshStyles() {
const objectId = modelRef.current && modelRef.current.objectId;
if (!objectId) return;
loadModel(() => props.refreshNodeModel(objectId));
}

function clearPick() {
modelRef.current = null;
shotSerial.current++;
treeSerial.current++;
setModel(null);
setShot(null);
setShotBusy(false);
setTree(null);
setEdit(null);
setError('');
if (props.hideNodeHighlight) props.hideNodeHighlight().catch(() => {});
}
// Keep the current element's breadcrumb chip in view. The strip reads
// root → … → current and starts scrolled to the left, so without this the
// one chip that explains what is selected is the one that is off-screen.
useEffect(() => {
const el = crumbRef.current;
if (el) el.scrollLeft = el.scrollWidth;
}, [tree]);

// Idle state — nothing selected yet. Prompts the user to tap the preview
// (if available) or type a selector.
if (!model) {
return h('div', { class: 'inspector__styles', role: 'group', 'aria-label': 'Element styles' },
h('div', { class: 'inspector__styles-empty', role: 'status' },
h('button', {
class: 'inspector__styles-pick' + (props.pickMode ? ' is-on' : ''),
type: 'button',
'aria-pressed': String(!!props.pickMode),
onClick: togglePickMode,
title: props.pickMode ? 'Pick mode on — tap the preview to select' : 'Pick mode off — tap the preview to select'
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
spellcheck: 'false',
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
const inlineRows = (model.inlineProps || []);
const computedRows = (model.computed || []);
// Hoist the properties changed in this session to the top of both lists
// (most recent first) so the edit you just made is the first thing you see,
// rather than something to hunt for in the ~400-row computed wall.
const declaredRows = orderChangedFirst(inlineRows, changed);
const orderedComputed = orderChangedFirst(computedRows, changed);
return h('div', { class: 'inspector__styles', role: 'group', 'aria-label': 'Element styles' },
// Sticky block: the element header and the pinned preview stay at the top
// of the panel's scroller while the property list below scrolls. Without
// this the header (and the only read-out of the edit's result) scrolled
// away as soon as the user reached the "Declared styles" rows.
h('div', { class: 'inspector__styles-pin' },
h('div', { class: 'inspector__styles-head' },
h('button', {
class: 'icon-btn icon-btn--labeled inspector__styles-clear',
type: 'button',
'aria-label': 'Clear selection',
title: 'Clear selection',
onClick: clearPick
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M6 6 18 18 M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })
),
h('span', { class: 'icon-btn__label' }, 'Clear')
),
h('div', { class: 'inspector__styles-elem' },
h('span', { class: 'inspector__styles-tag' }, label),
h('span', { class: 'inspector__styles-size' }, boxSummary(model.box))
),
h('div', { class: 'inspector__styles-tools' },
h('button', {
class: 'icon-btn icon-btn--labeled inspector__styles-refresh',
type: 'button',
'aria-label': 'Refresh styles',
title: 'Refresh styles',
disabled: loading,
onClick: refreshStyles
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M12 4V1L7 6l5 5V7c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8Z', fill: 'currentColor' })
),
h('span', { class: 'icon-btn__label' }, 'Refresh')
),
h('button', {
class: 'icon-btn icon-btn--labeled inspector__styles-pick' + (props.pickMode ? ' is-on' : ''),
type: 'button',
'aria-pressed': String(!!props.pickMode),
'aria-label': props.pickMode ? 'Stop picking — tap the preview to select' : 'Pick an element from the preview',
title: props.pickMode ? 'Stop picking — tap the preview to select' : 'Pick an element from the preview',
onClick: togglePickMode
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M5 3l14 7-6.5 1.5L10 19 5 3Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round' })
),
h('span', { class: 'icon-btn__label' }, props.pickMode ? 'Stop' : 'Pick')
)
)
),
// Breadcrumb — the selected element's ancestors as tap targets, plus the
// current element pinned at the end. It is the cheapest way to move up a
// level: one tap on `main` or `body` instead of re-picking a possibly
// overlapping element on the live preview. Horizontally scrollable because
// a deep tree cannot fit 360 px, and auto-scrolled to the end (see the
// effect above) so the chip for the element you are looking at is visible.
tree && tree.ancestors && tree.ancestors.length
? h('div', { class: 'inspector__styles-crumbs', ref: crumbRef, role: 'group', 'aria-label': 'Element ancestors' },
tree.ancestors.slice().reverse().map((a) => h('button', {
class: 'inspector__styles-crumb',
type: 'button',
key: 'anc-' + a.levels,
title: 'Select ' + a.label,
'aria-label': 'Select ancestor element ' + a.label,
onClick: () => selectAncestor(a.levels)
}, a.label)),
h('span', { class: 'inspector__styles-crumb is-here', key: 'here' }, label)
)
: null,
error ? h('p', { class: 'inspector__style-error', role: 'alert' }, error) : null,
// Pinned element preview: a clipped screenshot of the selected element, so
// the result of an edit is readable without scrolling back to the Preview
// panel. Hidden until the first capture lands.
shot
? h('button', {
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
}),
h('span', { class: 'inspector__styles-shot-note' }, shotBusy ? 'Updating…' : 'Tap to refresh')
)
: null
),
// Child chips — one tap into a child element. Deliberately *outside* the
// pinned block: the pin already carries the header, the breadcrumb, and the
// preview, and nothing that scrolls away should be the only route to a
// feature. The breadcrumb above brings the user straight back up, so losing
// sight of the children while reading the property list costs nothing.
tree && tree.children && tree.children.length
? h('div', { class: 'inspector__styles-kids', role: 'group', 'aria-label': 'Child elements' },
h('span', { class: 'inspector__styles-kids-label' }, 'Children'),
tree.children.map((c, i) => h('button', {
class: 'inspector__styles-kid',
type: 'button',
key: 'kid-' + i,
title: 'Select ' + c.label,
'aria-label': 'Select child element ' + c.label,
onClick: () => selectChild(i)
}, c.label)),
tree.childCount > tree.children.length
? h('span', { class: 'inspector__styles-kids-more' }, '+' + (tree.childCount - tree.children.length))
: null
)
: null,
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
onClick: () => setEdit({ prop: row.prop, value: row.value })
},
h('span', { class: 'inspector__styles-prop' }, row.prop),
isChanged(changed, row.prop) ? h('span', { class: 'inspector__styles-changed', 'aria-hidden': 'true' }, 'changed') : null,
h('span', { class: 'inspector__styles-val' }, row.value || '')
)
))
)
: h('p', { class: 'inspector__styles-none' }, 'No inline styles yet.', h('br'), 'Tap a chip below to add one.'),
h('div', { class: 'inspector__styles-add' },
h('span', { class: 'inspector__styles-add-label' }, 'Add'),
COMMON_CSS.map(([prop, desc]) => {
// A chip for a property that is already declared re-opens it with its
// current value. Opening it blank forced the value to be retyped from
// memory, and an accidental Apply wrote an empty value (which drops the
// declaration).
const current = inlineRows.find((x) => x.prop === prop);
return h('button', {
class: 'inspector__styles-chip' + (current ? ' is-set' : ''),
type: 'button',
title: current ? desc + ' — set to ' + current.value : desc,
'aria-label': current
? 'Edit ' + desc + ' (' + prop + '), currently ' + current.value
: 'Add ' + desc + ' (' + prop + ')',
onClick: () => setEdit({ prop, value: current ? current.value : '' })
}, prop);
})
)
),
h('div', { class: 'inspector__styles-section' },
h('h3', { class: 'inspector__styles-h' }, 'Computed'),
h('ul', { class: 'inspector__styles-list' },
orderedComputed.map((row) => h('li', {
class: 'inspector__styles-row inspector__styles-row--computed'
+ (isChanged(changed, row.prop) ? ' inspector__styles-row--changed' : ''),
key: row.prop
},
h('span', { class: 'inspector__styles-prop' }, row.prop),
h('span', { class: 'inspector__styles-val' }, row.value || '')
))
)
),
edit ? h(StyleEditSheet, {
prop: edit.prop,
value: edit.value,
isInline: true,
isRemove: inlineRows.some((x) => x.prop === edit.prop),
shot: shot && shot.src,
shotBusy,
onRefreshShot: captureShot,
onApply: applyEdit,
onRemove: removeEdit,
onDone: () => setEdit(null),
onCancel: () => setEdit(null)
}) : null
);
}
