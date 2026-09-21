'use strict';
// Inspector intent — describe the change, review a cited diff (Part H, pure half).
//
// The model's answer is a *suggestion*, so everything about it has to be
// checkable before a line is applied: the prompt is built from evidence the
// panel already read, the JSON is parsed tolerantly but filtered strictly, every
// proposal is validated against the page, and only ticked lines become writes.
// All of that is pure, and asserted here — the network call is not (it needs a
// configured model, which this machine does not have).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
// The Inspector CSS is split into per-panel parts behind an @import
// entry (frontend/src/inspector.css); readInspectorCss() inlines them so
// these regex checks still see the whole cascade.
const { readInspectorCss } = require('./inspector-css.js');
const read = (p) => (p === 'frontend/src/inspector.css'
  ? readInspectorCss()
  : fs.readFileSync(path.join(root, p), 'utf8'));
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
let passed = 0;
let failed = 0;
function check(name, condition, detail) {
if (condition) { passed++; console.log('  ok   - ' + name); }
else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}
const ctx = vm.createContext({});
vm.runInContext(strip(read('frontend/src/components/inspector/valueKinds.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/valueIndex.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/contrast.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/valueShapes.js')).replace(/^export \{ hslToRgb, rgbToHsl \};$/m, ''), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/intent.js'))
+ '\n;globalThis.IT = { MAX_PROPOSALS, MAX_CONTEXT_VALUES, SYSTEM_PROMPT, buildIntentPrompt, parseProposals, extractJson, validateProposals, selectable, applyPlan, intentSummary, proposalLine };\n', ctx);
const IT = ctx.IT;
check('the module loads', !!IT && typeof IT.parseProposals === 'function');
// ---- the prompt --------------------------------------------------------
{
const p = IT.buildIntentPrompt('make the spacing roomier', {
label: 'section.card.scale-a',
tag: 'section',
size: '448px × 112px',
declared: [{ prop: 'color', value: 'rgb(156, 194, 255)' }],
index: {
padding: { values: [4, 8, 12, 16], step: 4, unit: 'px', count: 5 },
gap: { values: [12], step: null, unit: 'px', tokens: [{ name: '--space-3', value: '12px' }] }
}
});
check('the prompt has a system and a user message', !!p.system && !!p.user);
check('the system message asks for JSON only', /Reply with JSON object and nothing else|JSON only/.test(p.system), p.system.slice(0, 120));
check('the system message states the schema', /"changes"/.test(p.system));
check('the user message names the element', /Element: section\.card\.scale-a/.test(p.user));
check('the user message carries the box size', /Box: 448px × 112px/.test(p.user));
check('the user message carries the declared declarations', /color: rgb\(156, 194, 255\)/.test(p.user));
check('the user message carries the page values', /padding: 4, 8, 12, 16/.test(p.user));
check('the user message carries the page step', /step 4px/.test(p.user));
check('the user message carries the tokens', /--space-3 = 12px/.test(p.user));
check('the user message ends with the request', /Change requested: make the spacing roomier/.test(p.user));
check('a missing index says so instead of inventing one',
/no page values read yet/.test(IT.buildIntentPrompt('x', {}).user));
check('a missing declaration list says so',
/\(none — it inherits or uses defaults\)/.test(IT.buildIntentPrompt('x', {}).user));
check('the proposals are capped in the prompt', new RegExp('at most ' + IT.MAX_PROPOSALS).test(p.system));
check('a very long element text is truncated',
IT.buildIntentPrompt('x', { role: 'y'.repeat(500) }).user.length < 2000);
// The prompt must not leak anything beyond what was handed to it.
check('the prompt contains nothing but the context it was given',
!JSON.stringify(p).includes('document.') && !/localStorage/.test(JSON.stringify(p)));
}
// ---- JSON extraction ---------------------------------------------------
check('a bare object is extracted', JSON.stringify(IT.extractJson('{"a":1}')) === '{"a":1}');
check('a fenced block is extracted', IT.extractJson('```json\n{"changes":[]}\n```').changes.length === 0);
check('prose around the object is ignored',
IT.extractJson('Sure! Here you go:\n{"changes":[]}\nHope that helps.').changes.length === 0);
check('a bare array is extracted', Array.isArray(IT.extractJson('[1,2]')));
check('a brace inside a string does not end the object',
IT.extractJson('{"why":"uses {braces}"}').why === 'uses {braces}');
check('an escaped quote inside a string does not end it',
IT.extractJson('{"why":"a \\" quote"}').why === 'a " quote');
check('a nested object is extracted whole',
IT.extractJson('{"a":{"b":1}}').a.b === 1);
check('no JSON at all yields null', IT.extractJson('I cannot help with that.') === null);
check('an empty string yields null', IT.extractJson('') === null);
check('null yields null', IT.extractJson(null) === null);
check('malformed JSON yields null', IT.extractJson('{"a":}') === null);
check('an unterminated object yields null', IT.extractJson('{"a":1') === null);
// ---- parsing the proposals ---------------------------------------------
{
const list = IT.parseProposals('{"changes":[{"property":"padding","value":"16px","why":"used 9×"}]}');
check('a proposal is parsed', list.length === 1, JSON.stringify(list));
check('the property is lower-cased', list[0].property === 'padding');
check('the value is kept', list[0].value === '16px');
check('the reason is kept', list[0].why === 'used 9×');
}
check('a bare array of proposals parses',
IT.parseProposals('[{"property":"gap","value":"12px"}]').length === 1);
check('a `proposals` key works too',
IT.parseProposals('{"proposals":[{"property":"gap","value":"12px"}]}').length === 1);
check('an object keyed by property parses',
IT.parseProposals('{"padding":"16px","gap":"12px"}').length === 2);
check('a `prop` alias is accepted',
IT.parseProposals('{"changes":[{"prop":"gap","value":"12px"}]}')[0].property === 'gap');
check('a custom property name is accepted',
IT.parseProposals('{"changes":[{"property":"--space-3","value":"12px","why":"token"}]}')[0].property === '--space-3');
check('a vendor-prefixed name is accepted',
IT.parseProposals('{"changes":[{"property":"-webkit-line-clamp","value":"2","why":"x"}]}')[0].property === '-webkit-line-clamp');
check('a proposal with no property is dropped',
IT.parseProposals('{"changes":[{"value":"16px"}]}').length === 0);
check('a proposal with an empty value is dropped',
IT.parseProposals('{"changes":[{"property":"padding","value":""}]}').length === 0);
check('a proposal with a blank value is dropped',
IT.parseProposals('{"changes":[{"property":"padding","value":"   "}]}').length === 0);
check('a sentence in the property slot is dropped',
IT.parseProposals('{"changes":[{"property":"make the spacing roomier","value":"16px"}]}').length === 0);
check('a duplicate proposal is dropped',
IT.parseProposals('{"changes":[{"property":"padding","value":"16px"},{"property":"padding","value":"16px"}]}').length === 1);
check('the same property with two values is kept twice',
IT.parseProposals('{"changes":[{"property":"padding","value":"16px"},{"property":"padding","value":"20px"}]}').length === 2);
check('an absurdly long value is dropped',
IT.parseProposals('{"changes":[{"property":"padding","value":"' + 'x'.repeat(300) + '"}]}').length === 0);
check('the list is capped', (() => {
const many = { changes: [] };
for (let i = 0; i < 20; i++) many.changes.push({ property: 'p-' + i, value: '1px' });
return IT.parseProposals(JSON.stringify(many)).length === IT.MAX_PROPOSALS;
})());
check('no JSON yields no proposals', IT.parseProposals('sorry, I cannot').length === 0);
check('an empty object yields no proposals', IT.parseProposals('{}').length === 0);
// ---- validating against the page ---------------------------------------
const CONTEXT = {
declared: [{ prop: 'color', value: 'rgb(156, 194, 255)' }, { prop: 'gap', value: '8px' }],
index: {
padding: { values: [4, 8, 12, 16], step: 4, unit: 'px', count: 9 },
gap: { values: [8, 12], step: 4, unit: 'px', count: 3 },
'border-radius': { values: [8], step: null, unit: 'px', count: 14 }
},
tokens: [
{ property: 'border-radius', name: '--r-md', value: '12px', count: 14 },
{ property: 'padding', name: '--space-4', value: '16px', count: 9 }
]
};
{
const list = IT.parseProposals('{"changes":[\
{"property":"padding","value":"16px","why":"roomier"},\
{"property":"border-radius","value":"12px","why":"softer"},\
{"property":"gap","value":"8px","why":"same"},\
{"property":"padding","value":"14px","why":"between"},\
{"property":"nonsense","value":"not a value"}]}');
const v = IT.validateProposals(list, CONTEXT);
check('every proposal survives into the review list', v.length === 5, String(v.length));
check('a page value is cited as already used',
/the page already uses 16px for padding|the token --space-4 is 16px/.test(v[0].citation), v[0].citation);
check('a token value is cited by name',
/the token --r-md is 12px/.test(v[1].citation), v[1].citation);
check('a token citation counts the other elements',
/used by 14 other elements/.test(v[1].citation), v[1].citation);
check('an element value equal to its own is blocked',
v[2].blocked === true, JSON.stringify(v[2]));
check('and the reason says it is already there',
/the element already has this value/.test(v[2].reason), v[2].reason);
check('an off-scale value is allowed but labelled new',
v[3].blocked === false && /a new value for padding/.test(v[3].citation), v[3].citation);
check('the new-value citation shows what the page uses instead',
/4, 8, 12/.test(v[3].citation), v[3].citation);
check('an unreadable value is blocked',
v[4].blocked === true, JSON.stringify(v[4]));
check('and its reason says the property cannot be checked',
/cannot check/.test(v[4].reason), v[4].reason);
// The padding proposal names the token whose value it matches (the strongest
// evidence), which is why its citation is the token rather than the count.
check('a value that matches a token cites the token',
/the token --space-4 is 16px/.test(v[0].citation), v[0].citation);
check('the from value comes from the element', v[0].from === '', JSON.stringify(v[0].from));
check('a declared property carries its current value', v[2].from === '8px', v[2].from);
check('a selectable filter drops only the blocked ones',
IT.selectable(v).length === 3, String(IT.selectable(v).length));
}
check('a property the page never declares is labelled as new',
IT.validateProposals([{ property: 'width', value: '100%', why: '' }], CONTEXT)[0].citation
=== 'a new value for width — the page does not declare it',
IT.validateProposals([{ property: 'width', value: '100%', why: '' }], CONTEXT)[0].citation);
check('a custom property proposal validates',
IT.validateProposals([{ property: '--space-3', value: '12px' }], CONTEXT)[0].blocked === false);
check('validation without a context does not crash',
IT.validateProposals([{ property: 'padding', value: '16px' }], {}).length === 1);
check('validation of nothing is nothing', IT.validateProposals(null, CONTEXT).length === 0);
check('a colour proposal validates',
IT.validateProposals([{ property: 'color', value: '#fff' }], CONTEXT)[0].blocked === false);
// ---- the write plan ----------------------------------------------------
{
const list = IT.validateProposals(IT.parseProposals('{"changes":[\
{"property":"padding","value":"16px"},\
{"property":"border-radius","value":"12px"}]}'), CONTEXT);
const plan = IT.applyPlan(list);
check('the plan has one entry per proposal', plan.length === 2, JSON.stringify(plan));
check('the entries are the property and value',
plan[0].prop === 'padding' && plan[0].value === '16px');
check('the plan preserves the order shown', plan.map((p) => p.prop).join(',') === 'padding,border-radius');
}
{
const twice = IT.validateProposals(IT.parseProposals('{"changes":[\
{"property":"padding","value":"16px"},{"property":"padding","value":"20px"}]}'), CONTEXT);
const plan = IT.applyPlan(twice);
check('a property proposed twice is one write', plan.length === 1, JSON.stringify(plan));
check('and it keeps the last value the user saw', plan[0].value === '20px', JSON.stringify(plan));
}
check('a blocked proposal is never written',
IT.applyPlan(IT.selectable(IT.validateProposals(
[{ property: 'padding', value: 'not-a-value' }, { property: 'padding', value: '16px' }], CONTEXT))).length === 1);
check('an empty plan for nothing', IT.applyPlan(null).length === 0);
check('an untickable proposal is dropped from the plan',
IT.applyPlan([{ prop: '', value: '1px' }]).length === 0);
// ---- the summary and the button label ----------------------------------
{
const list = IT.validateProposals(IT.parseProposals('{"changes":[\
{"property":"padding","value":"16px"},\
{"property":"border-radius","value":"12px"},\
{"property":"gap","value":"8px"}]}'), CONTEXT);
const s = IT.intentSummary(list);
check('the summary counts the proposals', s.total === 3, JSON.stringify(s));
check('the summary counts what can be applied', s.applicable === 2, JSON.stringify(s));
check('the summary counts what is selected', s.ticked === 2, JSON.stringify(s));
check('the summary counts what is blocked', s.blocked === 1, JSON.stringify(s));
check('the summary reads as numbers', /2 of 3 changes selected/.test(s.text), s.text);
check('the summary names the blocked count', /1 cannot be applied/.test(s.text), s.text);
}
{
const unticked = [{ property: 'padding', value: '16px', ticked: false, blocked: false }];
const s = IT.intentSummary(unticked);
check('an unticked proposal is not counted as selected', s.ticked === 0, JSON.stringify(s));
check('the label still reports the total', /0 of 1 change selected/.test(s.text), s.text);
}
check('an empty summary has no text', IT.intentSummary([]).text === '');
check('a single change is singular', /1 of 1 change selected/.test(IT.intentSummary([{ blocked: false }]).text));
check('the line shows the from and the to',
IT.proposalLine({ property: 'padding', from: '10px', value: '16px' }) === 'padding  10px → 16px',
IT.proposalLine({ property: 'padding', from: '10px', value: '16px' }));
check('the line omits a missing from',
IT.proposalLine({ property: 'padding', value: '16px' }) === 'padding  16px',
IT.proposalLine({ property: 'padding', value: '16px' }));
check('the line is safe for nothing', IT.proposalLine(null) === '');
// ---- the wiring --------------------------------------------------------
{
const panel = read('frontend/src/components/inspector/IntentPanel.jsx');
check('the panel renders the cited diff', /inspector__intent-row/.test(panel));
check('the panel makes the change count explicit', /Apply .* change/.test(panel) || /intentSummary/.test(panel));
check('the panel writes through the same inline-style path', /setInlineStyleProperty|onApply/.test(panel));
const css = read('frontend/src/inspector.css');
check('the intent surface is styled', /\.inspector__intent \{/.test(css));
check('the rows are ≥44 px targets', /\.inspector__intent-row \{[\s\S]{0,200}min-height:\s*44px/.test(css));
check('the surface wraps rather than scrolling sideways', /\.inspector__intent-rows \{[\s\S]{0,120}flex-direction:\s*column/.test(css));
check('the intent doc exists', /Inspector intent/.test(read('docs/features/inspector-intent.md')));
// The recent-model row is `{ provider, id, ts }` (the shape the chat picker
// reads), never `{ modelId }`. Reading the wrong key silently fell through to
// the project's first model, so the inspector and the chat disagreed about the
// default it documents. Keep both ends of that contract asserted.
const inspector = read('frontend/src/components/Inspector.jsx');
check('the inspector reads the recent row\'s model id, not a missing modelId field',
/fromRecent && fromRecent\.id/.test(inspector), 'fromRecent.id');
check('and it never reads a modelId field off a recent row',
!/fromRecent\s*&&\s*fromRecent\.modelId/.test(inspector));
const aiHandlers = read('src/server-handlers-ai.js');
check('the inspector pins the model to the provider it was picked from',
/providerId:\s*current\.providerId/.test(inspector));
check('/api/ai/chat resolves the model against that provider',
/resolveModel\(body\.modelId,\s*body\.projectDir,\s*body\.providerId\)/.test(aiHandlers),
'ai/chat providerId');
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' intent assertion(s) failed');
