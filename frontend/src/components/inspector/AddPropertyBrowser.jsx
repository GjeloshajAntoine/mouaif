// Inspector Styles panel — the "Add property" browser.
//
// This is the step the images call "Choose what to add": a touch-first browse of
// CSS properties, grouped, searchable, and drawn as *cards with a picture*
// rather than as rows of property names. Two reasons it exists at all:
//
//   1. The panel's declared list only shows what the element already declares, so
//      before this browser the only way to add the *first* style to an element was
//      the six quick chips or knowing a property name to type. Neither is a
//      browse.
//   2. A property name is not a description. `overflow` and `object-fit` look
//      equally plausible until one of them is drawn — a card that shows the box
//      with its content spilling out of it answers the question before the tap,
//      which is what makes the pick list usable one-handed.
//
// Picking a card hands the property to the panel, which opens the same edit sheet
// a declared row opens (pre-filled with the value the element has, or the family's
// neutral value when it has none). So this browser adds a *choice*, never a second
// editing path.
//
// Why it is a section of the Styles card and not a sheet
// -----------------------------------------------------
// It started as a bottom sheet (`AddPropertySheet.jsx`) rendered by the panel.
// Two things were wrong with that, and only the second was a bug:
//
//   - It covered the element. Choosing a property is a question about *this*
//     element — the pinned preview, the element's identity and the controls that
//     are already set are the context for every card — and a viewport-sized sheet
//     with a backdrop put all of that behind a scrim, on the one screen where the
//     user is comparing a card against what the element already has.
//   - Rendered inside `.inspector__styles` — a scroller nested in the page's own
//     scroller — the sheet could be laid out and clipped against that scroller
//     instead of the viewport, which put its own head, its Close button and its
//     search field off screen and out of reach (measured: overlay 497 px tall
//     instead of 960, head at `top -1053`, `elementFromPoint` at Close → null).
//
// Both are answered by the same change: the cards are now a normal block inside
// the panel's scroller, between **Style controls** and **Declared styles**, right
// under the **＋ Add property** button that opens it. Nothing is fixed, nothing is
// clipped, and the panel — with its sticky identity/preview block — is the surface
// that scrolls. See docs/features/inspector-touch-controls.md.
//
// The scrolling it does own
// -------------------------
// Switching group (or typing a search) replaces every card below the controls,
// so the list under the finger becomes a different list. The panel's scroller
// keeps its offset across that swap, which used to leave the new group rendered
// past its own end, with the chip row 2 192 px above the viewport: the tap read
// as "the panel emptied". The browser therefore asks for its own head — the
// search field and the chip row, which are what the user needs to choose again —
// to be brought into view after the swap, using the panel's shared
// `revealInPanel` helper so the sticky block above the scroller is accounted for.
// The same reveal runs when the browser is opened.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { LIBRARY_GROUPS, searchLibrary, libraryRow } from './styleControls.js';
import { revealInPanel } from './StyleControls.jsx';

// PropertyPreview — the card's picture, drawn in CSS from the property's family
// (see LIBRARY's `preview`). Deliberately abstract: a mini box, its padding or
// its shadow, not a rendering of the user's page, which no static diagram could
// be honest about.
function PropertyPreview(props) {
return h('span', { class: 'inspector__propcard inspector__propcard--' + (props.kind || 'none'), 'aria-hidden': 'true' },
h('span', { class: 'inspector__propcard-box' }),
h('span', { class: 'inspector__propcard-mark' }),
h('span', { class: 'inspector__propcard-glyph' }, props.glyph || 'Aa')
);
}

// AddPropertyBrowser — the card list. `open` gates it so the panel can mount it
// unconditionally; `ctx` is the same declared+computed pair the rest of the panel
// reads, which is what lets a card say the value the element has ("Already added
// · 16px") instead of only "already added".
export function AddPropertyBrowser(props) {
const [query, setQuery] = useState('');
const [group, setGroup] = useState('all');
// rootRef — the browser's own block, which is what the reveal measures and
// scrolls to. It is also how the scroller is found: the block lives inside
// `.inspector__styles`, so `closest` reads the panel's scroller without the
// panel having to hand it down (and without a second ref that could point at a
// different element than the one on screen).
const rootRef = useRef(null);
// revealHead — bring the search field and the chip row back into view. It runs
// after the DOM has the new list (an effect, keyed on the two inputs that swap
// it: the group and the query) and after the block is mounted, never from the
// tap handler, because the offset has to be measured against the height the tap
// produced.
function revealHead() {
const node = rootRef.current;
if (!node) return;
revealInPanel(node.closest('.inspector__styles'), node);
}
// A fresh open starts from the whole list — a search left over from the last
// time would hide the cards the user came back for — and brings the head into
// view, because the block renders *below* the Add-property button the user just
// tapped and the panel may have been scrolled anywhere.
useEffect(() => {
if (!props.open) return;
setQuery('');
setGroup('all');
revealHead();
}, [props.open]);
useEffect(() => {
if (!props.open) return;
revealHead();
}, [group, query]);
if (!props.open) return null;
const rows = searchLibrary(query, group).map((entry) => libraryRow(entry, props.ctx || {}));
const suggestions = (props.suggestions || []).map(([prop, desc, short]) => ({ prop, desc, short }));
return h('div', { class: 'inspector__addprop', id: 'inspector-addprop', ref: rootRef, role: 'region', 'aria-label': 'Add a property' },
h('div', { class: 'inspector__addprop-head' },
h('h3', { class: 'inspector__styles-h' }, 'Add a property'),
h('button', {
class: 'btn inspector__addprop-close',
type: 'button',
title: 'Close the property list',
onClick: props.onClose
}, 'Close')
),
h('label', { class: 'label', for: 'inspector-addprop-search' }, 'Search every property'),
h('input', {
class: 'input inspector__addprop-search',
id: 'inspector-addprop-search',
type: 'search',
value: query,
placeholder: 'padding, colour, shadow…',
autocapitalize: 'off',
autocorrect: 'off',
spellcheck: false,
enterkeyhint: 'search',
onInput: (e) => setQuery(e.currentTarget.value)
}),
// The suggestions are the properties the panel used to offer as six bare chips.
// They stay first, and they carry their description, because "what does `gap`
// do?" is the question the chips never answered.
suggestions.length && !query && group === 'all'
? h('div', { class: 'inspector__addprop-suggest', role: 'group', 'aria-label': 'Suggested properties' },
h('p', { class: 'inspector__addprop-h' }, 'Suggested'),
h('div', { class: 'inspector__touch-chips' },
suggestions.map((s) => {
const value = (props.ctx && props.ctx.declared || []).find((x) => x.prop === s.prop);
return h('button', {
class: 'inspector__touch-chip' + (value ? ' is-on' : ''),
type: 'button',
key: s.prop,
title: value ? s.prop + ' — set to ' + value.value : s.desc + ' (' + s.prop + ')',
onClick: () => props.onPick({ prop: s.prop, value: value ? value.value : '', isSet: !!value })
}, s.short || s.prop);
})
)
)
: null,
h('div', { class: 'inspector__addprop-tabs', role: 'group', 'aria-label': 'Property groups' },
LIBRARY_GROUPS.map((g) => h('button', {
class: 'inspector__touch-tab' + (group === g.id ? ' is-on' : ''),
type: 'button',
key: g.id,
'aria-pressed': String(group === g.id),
onClick: () => setGroup(g.id)
}, g.label))
),
rows.length
? h('ul', { class: 'inspector__addprop-list' },
rows.map((row) => h('li', { key: row.prop },
h('button', {
class: 'inspector__addprop-card' + (row.isSet ? ' is-set' : ''),
type: 'button',
title: row.title,
'aria-label': row.title,
onClick: () => props.onPick(row)
},
h(PropertyPreview, { kind: row.preview, glyph: row.label.slice(0, 2) }),
h('span', { class: 'inspector__addprop-text' },
h('span', { class: 'inspector__addprop-name' }, row.label),
h('code', { class: 'inspector__addprop-prop' }, row.prop),
h('span', { class: 'inspector__addprop-blurb' }, row.blurb)
),
h('span', { class: 'inspector__addprop-action' },
row.isSet
? h('span', { class: 'inspector__addprop-value' }, row.value || 'set')
: null,
h('span', { class: 'inspector__addprop-badge' }, row.action)
)
))
)
)
: h('p', { class: 'inspector__styles-none', role: 'status' },
'No property matches “' + query + '”. Try another word, or type the name in the editor\'s property field.'
),
h('p', { class: 'inspector__addprop-note' },
'Any property can be set — pick a card for the guided value editor, or type a name in the editor\'s own property field.'
)
);
}
