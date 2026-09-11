// Inspector Suggestions — the values this page already uses, on the page's scale.
//
// The type switch changes *how* a value is written (length, number, percentage,
// keyword) and the unit cycle rewrites the same value in another unit. Neither
// can answer "what should this be?", which is the question that actually stalls
// on a phone: the user has a keyboard, a value, and no idea whether the rest of
// the design uses 12, 14 or 16px.
//
// This component answers it from the page itself (see valueIndex.js): the values
// already declared for this property, most-used first, each with the rule that
// supplies it; the design tokens that resolve to a valid value for it; and the
// page's numeric step when its values share one.
//
// Part V3 adds two kinds of guidance on top of that list:
//
//   * Snapping (snapping.js) — when the value the user is typing is not one of
//     the page's own values, the row says so and names the nearest one, with a
//     one-tap "Snap to 16px". The value is never rewritten silently: the hint is
//     the offer, the tap is the decision.
//   * Contrast (contrast.js) — a colour candidate carries its WCAG ratio
//     against the element's resolved background, so a legibility mistake is
//     visible on the chip instead of after Apply.
//
// Tapping any chip only rewrites the sheet's value field — Apply still commits —
// so a suggestion is as reversible as anything typed.
import { h } from 'preact';
import { valuesFor, valuesSeen, tokensFor, scaleFor, scaleNote, siblingValues, valueKey } from './valueIndex.js';
import { keywordsFor } from './valueKinds.js';
import { snapValue, snapNote, usableScale } from './snapping.js';
import { readableOn, suggestTextColor } from './contrast.js';
// MAX_CHIPS — values shown. The list is a choice, not an inventory: a phone chip
// row can present a handful, and past that the long tail says nothing about the
// scale. The group header reports how many were actually seen.
const MAX_CHIPS = 6;
const MAX_TOKEN_CHIPS = 4;
// MAX_COLOUR_CHIPS — colour candidates get a swatch and a contrast badge, which
// is wider than a bare value chip, so the row shows fewer of them before it
// wraps to a second line.
const MAX_COLOUR_CHIPS = 5;
// MAX_SIBLING_CHIPS — the Match-a-sibling row. Each chip carries a value *and*
// the element it comes from (`2nd section.input-section`), which is twice a plain
// chip's width, so the row shows the few that matter rather than every peer.
const MAX_SIBLING_CHIPS = 3;
// MAX_WORD_CHIPS — the keyword row a *string* value gets. The mock's STRING row
// offers "the page's loaded font stacks, the CSS-wide keywords, the page's
// cursors": the stacks and the cursors come from the page groups above, and this
// is the other half — the keywords that are valid for any property, which are
// otherwise unreachable for a value with no per-kind view.
const MAX_WORD_CHIPS = 6;
// isColourProperty — whether a contrast reading applies. Colour chips are a
// separate group because their evidence is a ratio, not a use count.
function isColourProperty(prop, values) {
if (!values.length) return false;
const first = values[0] && values[0].value ? values[0].value : '';
return /^#|^(rgb|hsl)a?\(/i.test(first)
|| /^(color|background-color|border-color|outline-color|fill|stroke|caret-color|text-decoration-color|column-rule-color)$/.test(prop);
}
// swatchStyle — the small inline preview beside a colour candidate. Inline
// because the value is data, not theme: it is the user's own colour.
function swatchStyle(value) {
return { background: String(value || '') };
}
//
// contrastBadgeClass — the badge colour. A pass is neutral, a fail is the
// danger colour the sheet already uses for a rejected edit, because "this text
// would be unreadable" is a warning, not a decoration.
function badgeClass(readable) {
return 'inspector__suggest-aa' + (readable ? '' : ' is-bad');
}
// SnapHint — the one line that turns the page's scale into reachable guidance:
// on the scale, off it with the nearest value named, or nothing when the page
// has no scale to snap to.
//
// It is a live region rather than a plain paragraph because it changes while the
// user types, and it is the only feedback that a typed value is off-scale.
function SnapHint(props) {
const result = props.result;
// An empty field has nothing to snap, and a hint saying so would be noise on
// every fresh edit: the row appears once there is a value to judge.
if (!result || !result.value) return null;
const note = snapNote(result);
if (!note) return null;
if (result.snapped) {
return h('p', { class: 'inspector__suggest-snap is-on', role: 'status' }, note);
}
if (result.onScale) {
return h('p', { class: 'inspector__suggest-snap is-on', role: 'status' }, note);
}
if (result.offScale && result.nearest) {
return h('p', { class: 'inspector__suggest-snap is-off', role: 'status' },
h('span', { class: 'inspector__suggest-snap-ghost', 'aria-hidden': 'true' }, result.value),
h('span', null, note),
h('button', {
class: 'inspector__suggest-snap-btn',
type: 'button',
title: 'Rewrite the value as ' + result.nearest.value + ' — still one property, one undo',
'aria-label': 'Snap ' + result.value + ' to ' + result.nearest.value,
onClick: () => props.onSnap(result.nearest.value)
}, 'Snap to ' + result.nearest.value)
);
}
// No scale, or a value outside the scale's unit: the reason is worth one line,
// because "why is there no hint here?" is otherwise unanswerable.
return h('p', { class: 'inspector__suggest-snap is-none' }, note);
}
export function Suggestions(props) {
const index = props.index;
const prop = props.prop || '';
const value = props.value || '';
if (!index || !prop) return null;
const scale = usableScale(scaleFor(index, prop)) ? scaleFor(index, prop) : null;
const values = valuesFor(index, prop, MAX_CHIPS);
// How many values the page declares, before the chip cap. A page with thirty
// padding values would otherwise look exactly like one with three, which is the
// difference between "this property has a scale" and "here are three chips".
const seen = valuesSeen(index, prop);
const total = Math.max(seen.values, values.length);
const countText = total > values.length
? ' · ' + total + ' values seen'
: ' · ' + total + (total === 1 ? ' value' : ' values');
const tokens = tokensFor(index, prop, MAX_TOKEN_CHIPS);
// Match a sibling — what the element's peers use for this property. The page's
// stylesheet values are anonymous; a peer is a *referent* the user can go and
// look at ("the 2nd section.input-section uses 16px"), which is the question a
// spacing decision usually starts from. The value already in the field is
// dropped: offering the user their own value back is noise.
const siblings = siblingValues(props.siblings || [], prop)
.filter((s) => valueKey(s.value) !== valueKey(value))
.slice(0, MAX_SIBLING_CHIPS);
// A string value — `font-family`, `cursor`, `content`, `grid-template-areas` —
// has no rail and no per-kind view, so the typed field is the control. What it
// can still be given is the keyword forms: a family stack that falls back, a
// cursor that inherits, a `content` that is unset. `keywordsFor` returns the
// property's own keywords first and the CSS-wide four last, which is the order
// the row wants; the enum-shaped properties are skipped, because they render
// their own chips and two copies of the same row is worse than one.
const words = props.shape === 'text'
? keywordsFor(prop).filter((k) => valueKey(k) !== valueKey(value)).slice(0, MAX_WORD_CHIPS)
: [];
// Snapping is a property-level question (does this page have a step for this
// property?), so it is answered even when there is nothing to suggest: an
// off-scale value on a scale the index knows about is exactly the case where
// the hint matters most.
const snap = scale ? snapValue(prop, value, scale) : null;
// Colour candidates carry a contrast ratio against the element's own resolved
// background, so the group is rendered as swatches with a badge instead of a
// use count. `ownColour` means the value's own view is already rendering this
// palette, so the row does not render a second copy of it.
const colour = !props.ownColour && isColourProperty(prop, values);
const colourCtx = props.contrastCtx || {};
const colours = colour
? readableOn(colourCtx.bg || props.bg || '', values.map((v) => ({ value: v.value, count: v.count, selector: v.selector, isCurrent: v.isCurrent })), colourCtx).slice(0, MAX_COLOUR_CHIPS)
: [];
const defaults = colour && colours.length < 3
? suggestTextColor(colourCtx.bg || props.bg || '', colourCtx)
: [];
if (!values.length && !tokens.length && !snap && !siblings.length && !words.length) return null;
return h('div', { class: 'inspector__suggest' },
values.length
? h('div', { class: 'grp' },
h('div', { class: 'gh' }, colour ? 'This page\'s palette' : 'On this page',
h('span', null, countText
+ (scale && scale.step ? ' · steps of ' + scale.step + (scale.unit || '') : '')
+ (colour ? ' · contrast vs this element' : ''))
),
h('div', { class: 'opts' },
colour
? colours.map((v) => h('button', {
class: 'opt inspector__suggest-colour'
+ (v.isCurrent ? ' is-current' : '')
+ (v.readable ? '' : ' is-unreadable'),
type: 'button',
key: 'v-' + v.value,
title: v.value + ' — used ' + v.count + (v.count === 1 ? ' time' : ' times')
+ (v.selector ? ' (' + v.selector + ')' : '')
+ (v.text ? ' · ' + v.text + ' contrast' : v.reason ? ' · ' + v.reason : '')
+ (v.isCurrent ? ' · the value in force' : ''),
'aria-label': 'Use ' + v.value + ', used ' + v.count + (v.count === 1 ? ' time' : ' times')
+ (v.text ? ', contrast ' + v.text : ''),
onClick: () => props.onPick(v.value)
},
h('span', { class: 'inspector__suggest-sw', style: swatchStyle(v.value), 'aria-hidden': 'true' }),
h('span', { class: 'inspector__suggest-value' }, v.value),
v.text
? h('span', { class: badgeClass(v.readable) }, v.text)
: h('span', { class: 'inspector__suggest-ev' }, v.count + '×')
))
: values.map((v) => h('button', {
class: 'opt' + (v.isCurrent ? ' is-current' : ''),
type: 'button',
key: 'v-' + v.value,
title: v.value + ' — used ' + v.count + (v.count === 1 ? ' time' : ' times')
+ (v.selector ? ' (' + v.selector + ')' : '')
+ (v.inherited ? ', inherited from ' + v.inherited : '')
+ (v.isCurrent ? ' · the value in force' : ''),
'aria-label': 'Use ' + v.value + ', used ' + v.count + (v.count === 1 ? ' time' : ' times') + ' on this page',
onClick: () => props.onPick(v.value)
},
h('span', { class: 'inspector__suggest-value' }, v.value),
h('span', { class: 'inspector__suggest-ev' }, v.count + '×')
))
)
)
: null,
defaults.length
? h('div', { class: 'grp' },
h('div', { class: 'gh' }, 'Readable on this element', h('span', null, ' · the default pair')),
h('div', { class: 'opts' },
defaults.map((d) => h('button', {
class: 'opt inspector__suggest-colour' + (d.readable ? '' : ' is-unreadable'),
type: 'button',
key: 'd-' + d.value,
title: d.label + ' — ' + d.text + ' contrast on ' + (colourCtx.bg || 'this element'),
'aria-label': 'Use ' + d.label + ', contrast ' + d.text,
onClick: () => props.onPick(d.value)
},
h('span', { class: 'inspector__suggest-sw', style: swatchStyle(d.value), 'aria-hidden': 'true' }),
h('span', { class: 'inspector__suggest-value' }, d.label),
h('span', { class: badgeClass(d.readable) }, d.text)
))
)
)
: null,
siblings.length
? h('div', { class: 'grp' },
h('div', { class: 'gh' }, 'Match a sibling', h('span', null, ' · what the peers use')),
h('div', { class: 'opts' },
siblings.map((s) => h('button', {
class: 'opt inspector__suggest-sibling',
type: 'button',
key: 's-' + s.value,
title: s.value + ' — ' + (s.labels[0] || 'a sibling element') + ' uses ' + s.value
+ (s.count > 1 ? ' (' + s.count + ' peers)' : ''),
'aria-label': 'Use ' + s.value + ', what ' + (s.labels[0] || 'a sibling element') + ' uses',
onClick: () => props.onPick(s.value)
},
h('span', { class: 'inspector__suggest-value' }, s.value),
h('span', { class: 'inspector__suggest-ev' }, s.labels[0] || '')
))
)
)
: null,
tokens.length
? h('div', { class: 'grp' },
h('div', { class: 'gh' }, 'Tokens', h('span', null, ' · from this page')),
h('div', { class: 'opts' },
tokens.map((t) => h('button', {
class: 'opt inspector__suggest-token',
type: 'button',
key: 't-' + t.name,
title: t.name + ' = ' + t.value + (t.selector ? ' (' + t.selector + ')' : ''),
'aria-label': 'Use ' + t.name + ', which resolves to ' + t.value,
onClick: () => props.onPick(t.name)
},
h('span', { class: 'inspector__suggest-value' }, t.name),
h('span', { class: 'inspector__suggest-ev' }, '= ' + t.value)
))
)
)
: null,
words.length
? h('div', { class: 'grp' },
h('div', { class: 'gh' }, 'Keywords', h('span', null, ' · valid for any property')),
h('div', { class: 'opts' },
words.map((k) => h('button', {
class: 'opt inspector__suggest-word',
type: 'button',
key: 'w-' + k,
title: k + ' — the ' + (/^(inherit|initial|unset|revert)$/.test(k) ? 'CSS-wide' : 'property\'s own') + ' keyword',
'aria-label': 'Use ' + k,
onClick: () => props.onPick(k)
}, h('span', { class: 'inspector__suggest-value' }, k)))
)
)
: null,
h(SnapHint, { result: snap, onSnap: props.onPick }),
scale && scale.values.length > 1
? h('p', { class: 'inspector__suggest-note' }, scaleNote(scale))
: null
);
}
