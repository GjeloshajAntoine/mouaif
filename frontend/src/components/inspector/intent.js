// Inspector intent — describe the change, review a cited diff (Part H).
//
// The panel can already change a value the user has found. It cannot answer the
// question they actually arrive with ("make the spacing roomier"), because that
// is a request about the *page*, not about a declaration.
//
// This module is the pure half of that: it builds the prompt from evidence the
// panel already has, parses the model's answer into a proposal list, checks
// every proposal against the page before it is shown as applicable, and turns
// the accepted ones into the same `style.setProperty` writes the rest of the
// inspector makes.
//
//   buildIntentPrompt(intent, context) -> { system, user }
//   parseProposals(text)               -> [{ property, value, why }]
//   validateProposals(proposals, ctx)  -> proposals + { applicable, blocked, reason }
//   selectable(proposals)              -> the ones a user may tick
//   applyPlan(proposals)               -> [{ prop, value }] writes
//   intentSummary(proposals)           -> { total, applicable, text }
//
// Three rules, and they are the whole point of the feature:
//
//  1. **A proposal is never applied unseen.** Every line carries the evidence it
//     was derived from, and only ticked lines are written. The model's output is
//     a *suggestion*, which is why the UI's primary button says how many changes
//     it will make.
//  2. **A proposal that cannot be checked is marked, not hidden.** A property
//     the page has never used, a value off the page's own scale, a declaration
//     the element already has: each is shown with the reason, and the tick is
//     off, so the list is honest about what it does not know.
//  3. **Everything the model is told comes from a read the panel already made.**
//     The prompt carries the element, its declared declarations, the values and
//     tokens the page uses, and the numeric step — the same index the
//     suggestions row is built from. No new page scrape.
//
// Nothing here writes to the page or calls a model: the caller does both.
import { classify, formatNumber, propertyFamily } from './valueKinds.js';
// MAX_PROPOSALS — a proposal list longer than this is not a reviewed diff any
// more, it is a rewrite the user cannot check on a phone. The tail is reported
// rather than silently dropped.
export const MAX_PROPOSALS = 8;
// MAX_CONTEXT_VALUES — how many values per property the prompt carries. Enough
// for the model to see the scale, not so much that the prompt is a stylesheet.
export const MAX_CONTEXT_VALUES = 12;
// PROPOSAL_SCHEMA — the shape the model is asked for, stated in the prompt and
// re-stated in the system message. A JSON array of small objects is the one
// format that survives a phone-sized context and a non-deterministic model.
const PROPOSAL_SCHEMA = '{"changes":[{"property":"padding","value":"16px","why":"..."}]}';
// SYSTEM_PROMPT — what the model is asked to be. Kept short and concrete: it is
// asked to propose CSS declarations, to justify each one from the page context
// it was given, and to return nothing else.
export const SYSTEM_PROMPT = [
'You are the suggestion engine inside a CSS inspector in a mobile app.',
'The user selects one element in a live page and describes a change in words.',
'You are given that element, the declarations it already has, and the values and',
'design tokens the page itself uses for the properties in question.',
'',
'Reply with JSON only, no prose, in exactly this shape:',
PROPOSAL_SCHEMA,
'',
'Rules:',
'- One object per CSS declaration you propose. `property` is a CSS property name,',
'  `value` is a complete CSS value for it, `why` is one short sentence naming the',
'  evidence you used (a page value, a token, a relationship to the element).',
'- Prefer values that appear in the page context. If you propose a value that',
'  does not, say in `why` that it is new.',
'- Propose at most ' + MAX_PROPOSALS + ' changes.',
'- Never propose a property you cannot justify from the context.',
'Reply with the JSON object and nothing else.'
].join('\n');
// buildIntentPrompt — the pair of messages the caller sends. The context is
// assembled by the panel from what it has already read; anything missing is
// simply absent, and the prompt says so rather than inventing it.
export function buildIntentPrompt(intent, context) {
const c = context || {};
const request = String(intent || '').trim();
const lines = [];
lines.push('Element: ' + (c.label || '(unknown)'));
if (c.tag) lines.push('Tag: ' + c.tag);
if (c.size) lines.push('Box: ' + c.size);
if (c.role) lines.push('Text: ' + String(c.role).slice(0, 120));
lines.push('');
lines.push('Declarations this element has of its own:');
const declared = (c.declared || []).filter((d) => d && d.prop);
if (!declared.length) lines.push('- (none — it inherits or uses defaults)');
for (const d of declared.slice(0, 30)) {
lines.push('- ' + d.prop + ': ' + d.value + (d.changed ? ' (changed this session)' : ''));
}
lines.push('');
lines.push('Values this page uses, and the design tokens that resolve to them:');
for (const [prop, info] of Object.entries(c.index || {})) {
const values = (info && info.values) || [];
if (!values.length) continue;
lines.push('- ' + prop + ': ' + values.slice(0, MAX_CONTEXT_VALUES).map((v) => v).join(', ')
+ (info.step ? ' (step ' + formatNumber(info.step) + (info.unit || '') + ')' : ''));
if (info.tokens && info.tokens.length) {
lines.push('    tokens: ' + info.tokens.slice(0, MAX_CONTEXT_VALUES).map((t) => t.name + ' = ' + t.value).join(', '));
}
}
if (!Object.keys(c.index || {}).length) lines.push('- (no page values read yet)');
lines.push('');
lines.push('Change requested: ' + (request || '(none given)'));
return {
system: SYSTEM_PROMPT,
user: lines.join('\n')
};
}
// extractJson — the first JSON object or array in a string.
//
// A model asked for JSON-only usually complies and occasionally wraps it in a
// fenced block or a sentence. Failing the whole request over a code fence would
// be hostile, so the first balanced structure is taken; a reply with no JSON at
// all is a real failure and returns null.
//
// The *earliest* opening delimiter wins, not `{` first: scanning for `{` before
// `[` would find the object inside a top-level array and return one proposal
// instead of the list.
export function extractJson(text) {
const s = String(text == null ? '' : text);
const braceAt = s.indexOf('{');
const bracketAt = s.indexOf('[');
let open = '';
if (braceAt < 0) open = bracketAt < 0 ? '' : '[';
else if (bracketAt < 0) open = '{';
else open = bracketAt < braceAt ? '[' : '{';
if (!open) return null;
const start = open === '[' ? bracketAt : braceAt;
const close = open === '{' ? '}' : ']';
let depth = 0;
let inString = false;
let escaped = false;
for (let i = start; i < s.length; i++) {
const ch = s[i];
if (escaped) { escaped = false; continue; }
if (ch === '\\') { escaped = true; continue; }
if (ch === '"') { inString = !inString; continue; }
if (inString) continue;
if (ch === open) depth++;
else if (ch === close) {
depth--;
if (depth === 0) {
const candidate = s.slice(start, i + 1);
try { return JSON.parse(candidate); } catch { return null; }
}
}
}
return null;
}
// parseProposals — the model's answer as a proposal list.
//
// Tolerant about the container (`{changes:[…]}`, a bare array, or an object
// keyed by property) and strict about the content: a proposal without a
// plausible property name and a non-empty value is dropped, because a blank
// line in a review list is worse than a shorter list.
export function parseProposals(text) {
const json = extractJson(text);
if (!json) return [];
let raw = [];
if (Array.isArray(json)) raw = json;
else if (json && Array.isArray(json.changes)) raw = json.changes;
else if (json && Array.isArray(json.proposals)) raw = json.proposals;
else if (json && typeof json === 'object') {
raw = Object.entries(json).map(([property, v]) => {
if (v && typeof v === 'object') return Object.assign({ property }, v);
return { property, value: v };
});
}
const out = [];
for (const item of raw) {
if (!item || typeof item !== 'object') continue;
const property = String(item.property || item.prop || '').trim().toLowerCase();
const value = String(item.value == null ? '' : item.value).trim();
if (!property || !value) continue;
// A property name that is not a plausible CSS property is not a proposal; it is
// a sentence the model did not filter out.
if (!/^--[-a-z0-9]*$|^-?[a-z][a-z0-9-]*$/.test(property)) continue;
if (value.length > 200) continue;
const why = String(item.why || item.reason || '').trim();
if (out.some((p) => p.property === property && p.value === value)) continue;
out.push({ property, value, why });
if (out.length >= MAX_PROPOSALS) break;
}
return out;
}
// indexValueSet — the values the page uses for a property, as a lookup.
function indexValueSet(info, property) {
const unit = info && info.unit ? info.unit : '';
const set = new Set();
for (const v of (info && info.values) || []) {
const info2 = classify(property, String(v));
if (info2 && info2.number != null) set.add(formatNumber(info2.number));
}
return { set, unit };
}
// validateProposals — check each proposal against the page, and attach the
// evidence the review line shows.
//
// A proposal is marked `blocked` with a reason when it cannot be applied or
// cannot be checked:
//   * the property is unknown to the page *and* not a plain CSS-looking name;
//   * the value is not parseable as a value for that property;
//   * the value is the declaration the element already has (a no-op);
//   * the value is off the page's own numeric scale (allowed, but flagged —
//     "new value" is the honest label, not an error).
//
// Nothing is removed: a blocked proposal is shown with its reason and starts
// unticked, because the user is the one who decides whether the model is right.
export function validateProposals(proposals, context) {
const c = context || {};
const index = c.index || {};
const declared = c.declared || [];
return (proposals || []).map((p) => {
const property = p.property;
const value = p.value;
const info = classify(property, value);
const declaredRow = declared.find((d) => d && String(d.prop || '').toLowerCase() === property);
const declaredValue = declaredRow ? String(declaredRow.value || '').trim() : '';
const pageInfo = index[property];
const base = Object.assign({}, p, {
from: declaredValue,
blocked: false,
reason: '',
onScale: false,
citation: '',
});
if (!info || info.kind === 'unknown') {
// An unparsable value is the one hard block: there is nothing to write.
return Object.assign(base, {
blocked: true,
reason: 'this is not a value the inspector can read for ' + property
});
}
// A property the page does not declare *and* that the inspector cannot type is
// not checkable at all: the proposal would be an unreviewable guess on a
// property that may not exist. A property it can type (`width`) is fine even
// when the page has never used it.
if (!pageInfo && !String(property).startsWith('--') && propertyFamily(property) === 'unknown') {
return Object.assign(base, {
blocked: true,
reason: 'the page does not declare ' + property + ' and the inspector cannot check it'
});
}
if (declaredValue && declaredValue === value) {
return Object.assign(base, {
blocked: true,
reason: 'the element already has this value'
});
}
// The citation: where the value came from. A page value is the strongest
// evidence (it is what the design already uses); a token is named; anything
// else is honestly called new.
const scale = pageInfo ? indexValueSet(pageInfo, property) : { set: new Set(), unit: '' };
const token = (c.tokens || []).find((t) => t && t.property === property
&& String(t.value || '').trim() === value);
if (token) {
return Object.assign(base, {
onScale: true,
citation: 'the token ' + token.name + ' is ' + value + ' — used by ' + (token.count || 0) + ' other elements'
});
}
if (info.number != null && scale.set.has(formatNumber(info.number))) {
return Object.assign(base, {
onScale: true,
citation: 'the page already uses ' + value + ' for ' + property
+ (pageInfo && pageInfo.count ? ' in ' + pageInfo.count + ' places' : '')
});
}
if (pageInfo) {
return Object.assign(base, {
citation: 'a new value for ' + property + ' — the page uses '
+ ((pageInfo.values || []).slice(0, 3).join(', ') || 'nothing yet')
});
}
return Object.assign(base, {
citation: 'a new value for ' + property + ' — the page does not declare it'
});
});
}
// selectable — the proposals a user may tick: everything not hard-blocked. An
// off-scale value is selectable, because "the page does not use this" is not
// "this is wrong".
export function selectable(proposals) {
return (proposals || []).filter((p) => !p.blocked);
}
// applyPlan — the writes for the ticked proposals, in the order they are shown.
//
// One entry per proposal, so `recordChange` folds them into one receipt entry
// per property and the whole intent is one undo. A property proposed twice keeps
// its last value, which is what the user saw in the list.
export function applyPlan(proposals) {
const out = [];
for (const p of proposals || []) {
if (!p || p.blocked) continue;
const property = String(p.property || '').trim();
const value = String(p.value == null ? '' : p.value).trim();
if (!property || !value) continue;
const at = out.findIndex((x) => x.prop === property);
if (at >= 0) out[at] = { prop: property, value, ticked: p.ticked !== false };
else out.push({ prop: property, value, ticked: p.ticked !== false });
}
return out;
}
// intentSummary — the header and the primary button's label.
//
// The button has to say how many changes it will make: "Apply 3 changes" is a
// decision the user can check against the list, "Apply" is not.
export function intentSummary(proposals) {
const list = proposals || [];
const applicable = list.filter((p) => !p.blocked);
const ticked = applicable.filter((p) => p.ticked !== false);
const blocked = list.length - applicable.length;
return {
total: list.length,
applicable: applicable.length,
ticked: ticked.length,
blocked,
// The line under the list: what will happen, in numbers.
text: list.length === 0
? ''
: ticked.length + ' of ' + list.length + (list.length === 1 ? ' change' : ' changes') + ' selected'
+ (blocked ? ' · ' + blocked + ' cannot be applied' : '')
};
}
// proposalLine — the review row's text: `padding  10px → 16px`.
export function proposalLine(p) {
const prop = String((p && p.property) || '').trim();
const from = String((p && p.from) || '').trim();
const to = String((p && p.value) || '').trim();
if (!prop && !to) return '';
if (!from) return prop + '  ' + to;
return prop + '  ' + from + ' → ' + to;
}
