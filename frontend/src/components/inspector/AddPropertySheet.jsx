// Inspector StylesPanel — the "Add property" sheet.
//
// The step the images call "Choose what to add": a touch-first browse of CSS
// properties, grouped, searchable, and drawn as *cards with a picture* rather
// than as rows of property names. Two reasons it exists at all:
//
//   1. The panel's declared list only shows what the element already declares, so
//      before this sheet the only way to add the *first* style to an element was
//      the six quick chips or knowing a property name to type. Neither is a
//      browse.
//   2. A property name is not a description. `overflow` and `object-fit` look
//      equally plausible until one of them is drawn — a card that shows the box
//      with its content spilling out of it answers the question before the tap,
//      which is what makes the pick list usable one-handed.
//
// Picking a card hands the property to the panel, which opens the same edit sheet
// a declared row opens (pre-filled with the value the element has, or the family's
// neutral value when it has none). So this sheet adds a *choice*, never a second
// editing path.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { LIBRARY_GROUPS, searchLibrary, libraryRow } from './styleControls.js';
import { sheetPortal } from './sheetPortal.js';

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

// AddPropertySheet — the card list. `open` gates it so the panel can mount it
// unconditionally; `ctx` is the same declared+computed pair the rest of the panel
// reads, which is what lets a card say the value the element has ("Already added
// · 16px") instead of only "already added".
export function AddPropertySheet(props) {
const [query, setQuery] = useState('');
const [group, setGroup] = useState('all');
// bodyRef — the sheet's own scroller. Its offset has to be reset when the list
// under it is replaced, and only the DOM node knows the current offset.
const bodyRef = useRef(null);
// A fresh open starts from the whole list: a search left over from the last time
// would hide the cards the user came back for.
useEffect(() => {
if (props.open) { setQuery(''); setGroup('all'); }
}, [props.open]);
// Picking a category (or typing a search) *replaces* every card below the
// controls, and the body keeps its `scrollTop` across that swap — clamped to
// whatever maximum the new, shorter list has. Measured against the styles
// fixture at 360 x 667: reading the end of the All list (`scrollTop 2208/2208`)
// and tapping **Type** left the body at `183/183` — scrolled to the end of the
// new list — with the group chip row at `top 63`, i.e. 93 px *above* the body's
// own top edge and completely out of view. The new list therefore looked empty
// and the chips you had just tapped were gone, so changing category twice meant
// scrolling back up first.
//
// The controls live at the top of this scroller, so returning to `scrollTop 0`
// puts the search field, the chips and the first cards back in view — which is
// what the tap was asking for. Keyed on the group and the query because those
// are exactly the two inputs that swap the list out.
useEffect(() => {
const body = bodyRef.current;
if (body) body.scrollTop = 0;
}, [group, query]);
if (!props.open) return null;
const rows = searchLibrary(query, group).map((entry) => libraryRow(entry, props.ctx || {}));
const suggestions = (props.suggestions || []).map(([prop, desc, short]) => ({ prop, desc, short }));
// Portalled to the document root: this sheet is mounted by the Styles panel,
// i.e. inside `.inspector__styles` — a scroller nested in the page's own
// scroller — where a fixed overlay is contained and clipped on a phone (see
// sheetPortal.js). At the root the backdrop covers the whole viewport and the
// head, Close and search field stay reachable.
return sheetPortal(h('div', { class: 'inspector__overlay', onClick: props.onClose },
h('div', {
class: 'inspector__sheet inspector__sheet--addprop',
role: 'dialog',
'aria-modal': 'true',
'aria-label': 'Add a CSS property',
onClick: (e) => e.stopPropagation()
},
h('div', { class: 'inspector__sheet-head' },
h('strong', { class: 'inspector__sheet-title' }, 'Add a property'),
h('button', { class: 'btn inspector__sheet-close', type: 'button', onClick: props.onClose }, 'Close')
),
h('div', { class: 'inspector__sheet-body inspector__addprop-body', ref: bodyRef },
h('label', { class: 'label', for: 'inspector-addprop-search' }, 'Search every property'),
h('input', {
class: 'input inspector__addprop-search',
id: 'inspector-addprop-search',
type: 'search',
value: query,
placeholder: 'padding, colour, shadow…',
autocapitalize: 'off',
autocorrect: 'off',
spellcheck: 'false',
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
)
)
));
}
