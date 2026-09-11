// Inspector Intent — say what you want changed, review a cited diff (Part H).
//
// The rest of the inspector changes a value the user has already found. This is
// the other entry point: describe the change in words ("make the spacing
// roomier"), get a proposal list, and apply the lines you tick. It is the H
// frame of the mockups.
//
// What makes it reviewable rather than magical:
//
//   * every line shows `property  from → to`, the evidence it was derived from
//     ("the page already uses 16px for padding in 9 places", "the token --r-md
//     is 12px"), and its own tick;
//   * a line the panel cannot check starts unticked with the reason — a value it
//     cannot parse, a property the page does not declare and the inspector
//     cannot type, or a no-op against what the element already has;
//   * the primary button says how many changes it will make ("Apply 3 changes"),
//     so the list and the button can be checked against each other;
//   * applying goes through the same `style.setProperty` path as every other
//     edit, so the whole intent is one receipt entry per property and one undo.
//
// The model call is the caller's (`props.onPropose`), because the network and
// the credentials are not this component's business — and because a pure parser
// is the part that has to be right.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { parseProposals, validateProposals, intentSummary } from './intent.js';

// PROMPT_PLACEHOLDER — the one example worth putting in the field. It has to be
// a *request*, not a value, or the affordance reads as another value input.
const PROMPT_PLACEHOLDER = 'make the spacing roomier…';

// EXAMPLES — what a user might type. Three is enough to teach the shape of the
// interaction without turning the empty state into a manual.
const EXAMPLES = [
'make the spacing roomier',
'tighten the type',
'tone the colours down'
];

export function IntentPanel(props) {
const [text, setText] = useState('');
const [busy, setBusy] = useState(false);
const [error, setError] = useState('');
const [answer, setAnswer] = useState('');
// proposalState — the parsed, validated list plus the per-line ticks. Kept in
// one object so a tick does not have to re-parse the model's answer.
const [proposals, setProposals] = useState(null);
const alive = useRef(true);
useEffect(() => () => { alive.current = false; }, []);
// A new selection invalidates the diff: its lines name properties of the element
// that was selected, so applying them to another element would write to the
// wrong node.
useEffect(() => {
setProposals(null);
setAnswer('');
setError('');
}, [props.selectionKey]);

async function ask(intent) {
const request = String(intent || text || '').trim();
if (!request || busy || !props.onPropose) return;
setBusy(true);
setError('');
setAnswer('');
setProposals(null);
try {
const reply = await props.onPropose(request);
if (!alive.current) return;
const raw = typeof reply === 'string' ? reply : (reply && reply.text) || '';
setAnswer(raw);
const parsed = parseProposals(raw);
if (!parsed.length) {
setError('No changes came back. Try describing the property you mean — "make the padding roomier".');
setProposals([]);
return;
}
const validated = validateProposals(parsed, props.context || {});
setProposals(validated.map((p) => Object.assign({}, p, { ticked: !p.blocked })));
} catch (e) {
if (!alive.current) return;
setError((e && e.message) || 'The suggestion request failed.');
} finally {
if (alive.current) setBusy(false);
}
}

function toggle(i) {
setProposals((prev) => (prev || []).map((p, at) => (at === i ? Object.assign({}, p, { ticked: !p.ticked }) : p)));
}

async function apply() {
const list = (proposals || []).filter((p) => p.ticked && !p.blocked);
if (!list.length || busy || !props.onApply) return;
setBusy(true);
setError('');
try {
const result = await props.onApply(list.map((p) => ({ prop: p.property, value: p.value })));
if (!alive.current) return;
setProposals(null);
setAnswer('');
setText('');
if (props.onDone) props.onDone(result);
} catch (e) {
if (!alive.current) return;
setError((e && e.message) || 'Could not apply the changes.');
} finally {
if (alive.current) setBusy(false);
}
}

const summary = proposals ? intentSummary(proposals) : null;
const ready = !!props.connected;
return h('div', { class: 'inspector__intent', role: 'group', 'aria-label': 'Describe a change' },
h('div', { class: 'inspector__intent-head' },
h('strong', { class: 'inspector__intent-title' }, 'Describe a change'),
h('span', { class: 'inspector__intent-meta' },
ready ? (props.label || 'the selected element') : 'no element selected')
),
// The field. A plain input rather than a textarea: one sentence is the input,
// and a growing box would push the diff off a 360 px screen.
h('div', { class: 'inspector__intent-ask' },
h('input', {
class: 'input inspector__intent-input',
type: 'text',
value: text,
placeholder: PROMPT_PLACEHOLDER,
autocapitalize: 'sentences',
autocorrect: 'on',
spellcheck: 'true',
disabled: !ready || busy,
'aria-label': 'Describe the change you want',
onInput: (e) => setText(e.currentTarget.value),
onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(text); } }
}),
h('button', {
class: 'btn inspector__intent-go',
type: 'button',
disabled: !ready || busy || !text.trim(),
'aria-label': 'Propose changes',
onClick: () => ask(text)
}, busy ? 'Thinking…' : 'Propose')
),
!ready
? h('p', { class: 'inspector__intent-note' }, 'Select an element first — the description is about the element you picked.')
: null,
// The empty state: three examples, so the interaction is legible without a
// manual. They are buttons because typing one is the whole point.
!proposals && ready && !busy
? h('div', { class: 'inspector__intent-examples' },
EXAMPLES.map((e) => h('button', {
class: 'inspector__intent-chip',
type: 'button',
key: e,
onClick: () => { setText(e); ask(e); }
}, e))
)
: null,
summary && summary.total
? h('div', { class: 'inspector__intent-summary' },
h('span', null, summary.text)
)
: null,
proposals && proposals.length
? h('div', { class: 'inspector__intent-rows', role: 'group', 'aria-label': 'Proposed changes' },
proposals.map((p, i) => h('button', {
class: 'inspector__intent-row'
+ (p.blocked ? ' is-blocked' : '')
+ (p.ticked && !p.blocked ? ' is-ticked' : ''),
type: 'button',
key: p.property + '-' + p.value,
role: 'checkbox',
'aria-checked': String(!!p.ticked && !p.blocked),
'aria-disabled': String(!!p.blocked),
title: p.blocked ? p.reason : p.citation,
// A blocked line is not tappable: it has no write to make, and a tick that
// does nothing is worse than a line that says why.
onClick: () => { if (!p.blocked) toggle(i); }
},
h('span', { class: 'inspector__intent-tick', 'aria-hidden': 'true' }, p.blocked ? '·' : (p.ticked ? '✓' : '')),
h('span', { class: 'inspector__intent-body' },
h('span', { class: 'inspector__intent-line' },
h('b', null, p.property),
p.from ? h('span', { class: 'inspector__intent-was' }, p.from) : null,
p.from ? h('span', { class: 'inspector__intent-arrow', 'aria-hidden': 'true' }, '→') : null,
h('span', { class: 'inspector__intent-now' }, p.value)
),
h('span', { class: 'inspector__intent-why' }, p.blocked ? 'not applied — ' + p.reason : p.citation)
)
))
)
: null,
summary && summary.total
? h('div', { class: 'inspector__intent-actions' },
h('button', {
class: 'btn inspector__intent-apply',
type: 'button',
disabled: busy || !summary.ticked,
onClick: apply
}, summary.ticked === 1 ? 'Apply 1 change' : 'Apply ' + summary.ticked + ' changes'),
h('button', {
class: 'btn inspector__intent-clear',
type: 'button',
disabled: busy,
onClick: () => { setProposals(null); setAnswer(''); setError(''); }
}, 'Discard')
)
: null,
error ? h('p', { class: 'inspector__intent-error', role: 'alert' }, error) : null,
// The raw answer, collapsible: when the model returns something that parses to
// nothing, the user (and a bug report) needs to see what it actually said.
answer && !proposals
? h('p', { class: 'inspector__intent-raw' }, answer.slice(0, 400))
: null
);
}
export default IntentPanel;
