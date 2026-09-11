'use strict';

// Inspector edit scope and receipt.
//
// The panel's edits all land on element.style for one property, which is the
// safest target — but the UI said only "this row changed", never what was kept
// or how to get back. frontend/src/components/inspector/scope.js computes the
// scope numbers and the undo plan, so the guarantees are asserted here instead
// of being eyeballed in the panel:
//
//   * a write changes exactly one property, creates at most one, and keeps every
//     other declaration (it cannot touch them — setProperty writes one name);
//   * no stylesheet rule is edited and no other element is affected;
//   * a repeated edit on one property keeps the ORIGINAL value for undo, so one
//     undo reaches the state before the session, not before the last tap;
//   * a property that did not exist before is REMOVED on undo, not set to an
//     empty string;
//   * an edit that ends where it started leaves no entry and nothing to undo.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');

const source = strip(read('frontend/src/components/inspector/scope.js'));
const stylesSource = read('frontend/src/components/inspector/StylesPanel.jsx');
const css = read('frontend/src/inspector.css');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

const ctx = vm.createContext({});
vm.runInContext(source + '\n;globalThis.SC = { MAX_RECEIPT, scopeSummary, describeChange, recordChange, undoPlan, undoOrder, summarizeReceipt, receiptRows };\n', ctx);
const SC = ctx.SC;

const DECLARED = [
  { prop: 'margin', value: '0px 0px 18px' },
  { prop: 'padding', value: '14px' },
  { prop: 'border-radius', value: '8px' },
  { prop: 'background-color', value: 'rgb(28, 35, 51)' }
];

// ---- scope summary -----------------------------------------------------

{
  const s = SC.scopeSummary({ declared: DECLARED, edited: 'padding' });
  check('a write changes exactly one property', s.changed === 1);
  check('an existing property is overridden, not added', s.added === 0);
  check('every other declaration is kept', s.kept === 3, String(s.kept));
  check('no stylesheet rule is edited', s.rulesEdited === 0);
  check('only this element is affected', s.elements === 1);

  const added = SC.scopeSummary({ declared: DECLARED, edited: 'color' });
  check('a property that did not exist counts as added', added.added === 1);
  check('adding still keeps all existing declarations', added.kept === 4, String(added.kept));

  const none = SC.scopeSummary({ declared: DECLARED });
  check('nothing pending means nothing changed', none.changed === 0 && none.elements === 0 && none.added === 0);
  check('kept is the whole list when nothing is pending', none.kept === 4);
  check('the property name is matched case-insensitively',
    SC.scopeSummary({ declared: [{ prop: 'Padding', value: '1px' }], edited: 'padding' }).added === 0);
  check('a name-shaped row (from CDP) counts too',
    SC.scopeSummary({ declared: [{ name: 'padding', value: '1px' }], edited: 'padding' }).kept === 0);
}

// ---- the receipt: recording --------------------------------------------

{
  let r = SC.recordChange([], { prop: 'padding', from: '10px', to: '14px' });
  check('the first edit is recorded', r.length === 1 && r[0].prop === 'padding');
  check('the entry keeps the previous value', r[0].from === '10px' && r[0].to === '14px');

  r = SC.recordChange(r, { prop: 'padding', from: '14px', to: '20px' });
  check('re-editing the same property does not add a line', r.length === 1);
  check('re-editing keeps the ORIGINAL previous value', r[0].from === '10px', r[0].from);
  check('and updates the value it now has', r[0].to === '20px');

  r = SC.recordChange(r, { prop: 'padding', from: '20px', to: '10px' });
  check('an edit that ends where it started leaves no entry', r.length === 0, JSON.stringify(r));

  let added = SC.recordChange([], { prop: 'color', from: '', to: '#fff' });
  check('a new property records an empty previous value', added[0].from === '');
  check('a removal records an empty next value',
    SC.recordChange([], { prop: 'color', from: '#fff', to: '' })[0].to === '');
  check('a no-op write of nothing is not recorded',
    SC.recordChange([], { prop: 'color', from: '', to: '' }).length === 0);
  check('an entry without a property is not recorded',
    SC.recordChange([], { from: 'a', to: 'b' }).length === 0);
  check('recording does not mutate the input list', (() => {
    const before = [{ prop: 'a', from: '1', to: '2' }];
    const after = SC.recordChange(before, { prop: 'b', from: '', to: '3' });
    return before.length === 1 && after.length === 2;
  })());
}

// A long session cannot grow the strip without bound.
{
  let r = [];
  for (let i = 0; i < SC.MAX_RECEIPT + 5; i++) {
    r = SC.recordChange(r, { prop: 'p' + i, from: '', to: String(i) });
  }
  check('the receipt is capped', r.length === SC.MAX_RECEIPT, String(r.length));
  check('the cap keeps the newest entries', r[r.length - 1].prop === 'p' + (SC.MAX_RECEIPT + 4));
}

// ---- the receipt: undoing ----------------------------------------------

{
  const plan = SC.undoPlan({ prop: 'padding', from: '10px', to: '14px' });
  check('undoing an override sets the previous value back', plan.kind === 'set' && plan.value === '10px');

  const removed = SC.undoPlan({ prop: 'color', from: '', to: '#fff' });
  check('undoing an added property removes it', removed.kind === 'remove' && removed.prop === 'color');
  check('a removal plan carries no value', removed.value === '');
  check('there is no undo plan without a property', SC.undoPlan({}) === null);
  check('there is no undo plan for null', SC.undoPlan(null) === null);

  const order = SC.undoOrder([{ prop: 'a' }, { prop: 'b' }, { prop: 'c' }]);
  check('undo all runs newest first', order.map((e) => e.prop).join('') === 'cba', order.map((e) => e.prop).join(''));
  check('undoOrder does not mutate the receipt', (() => {
    const r = [{ prop: 'a' }, { prop: 'b' }];
    SC.undoOrder(r);
    return r[0].prop === 'a';
  })());
}

// Two edits to different properties undo independently, in any order.
{
  let r = [];
  r = SC.recordChange(r, { prop: 'padding', from: '10px', to: '14px' });
  r = SC.recordChange(r, { prop: 'margin', from: '', to: '8px' });
  check('two properties are two entries', r.length === 2);
  const plans = SC.undoOrder(r).map((e) => SC.undoPlan(e));
  check('undo all restores and removes as appropriate',
    plans[0].kind === 'remove' && plans[0].prop === 'margin'
    && plans[1].kind === 'set' && plans[1].value === '10px',
    JSON.stringify(plans));
}

// ---- the strip's rows --------------------------------------------------

{
  const rows = SC.receiptRows([
    { prop: 'padding', from: '10px', to: '14px' },
    { prop: 'color', from: '', to: '#fff' }
  ]);
  check('rows are newest first', rows[0].prop === 'color', rows[0].prop);
  check('a row prints from → to', rows[1].text === 'padding 10px → 14px', rows[1].text);
  check('an added property prints a dash for the missing previous value',
    rows[0].text === 'color — → #fff', rows[0].text);
  check('a row knows it was not set before', rows[0].wasSet === false && rows[1].wasSet === true);
  check('a removal is described as a removal',
    SC.describeChange({ prop: 'color', from: '#fff', to: '' }).text === 'color #fff → (removed)');
  check('rows carry a stable key', rows.every((r) => typeof r.key === 'string' && r.key.length > 2));

  const sum = SC.summarizeReceipt([{ prop: 'a', from: '', to: '1' }, { prop: 'b', from: '2', to: '' }]);
  check('the summary counts the entries', sum.count === 2);
  check('the summary counts added properties', sum.added === 1);
  check('the summary counts removals', sum.removed === 1);
  check('an empty receipt has nothing to undo', SC.summarizeReceipt([]).hasChanges === false);
  check('a non-array receipt is treated as empty', SC.summarizeReceipt(null).count === 0);
}

// ---- the panel wiring --------------------------------------------------

check('the panel keeps a receipt', /const \[receipt, setReceipt\] = useState\(\[\]\)/.test(stylesSource));
check('an applied edit records what it replaced',
  /recordChange\(prev, \{ prop, from: prevValue, to: value \}\)/.test(stylesSource), null);
check('the previous value is read before the write',
  /const prevValue = \(\(modelRef\.current && modelRef\.current\.inlineProps\) \|\| \[\]\)[\s\S]{0,160}recordChange/.test(stylesSource));
check('a removal is recorded too', /recordChange\(prev, \{ prop, from: .*to: '' \}\)/.test(stylesSource));
check('undo uses the plan rather than guessing',
  /undoPlan\(entry\)/.test(stylesSource) && /plan\.kind === 'remove'/.test(stylesSource));
check('undo all runs through undoOrder', /undoOrder\(receipt\)/.test(stylesSource));
check('undoing drops the property from the changed set',
  /setChanged\(\(prev\) => unmarkChanged\(prev, plan\.prop\)\)/.test(stylesSource));
check('a new selection clears the receipt (the entries belong to the old element)',
  /if \(!m \|\| m\.objectId !== prevId\) \{ setChanged\(\[\]\); setReceipt\(\[\]\); \}/.test(stylesSource)
  || /setReceipt\(\[\]\)[\s\S]{0,120}setChanged\(\[\]\)/.test(stylesSource),
  'receipt reset on selection change');
check('clearing the selection clears the receipt', /function clearPick\(\)[\s\S]{0,400}setReceipt\(\[\]\)/.test(stylesSource));
check('the sheet is told how many declarations are kept',
  /declared: inlineRows/.test(stylesSource));
check('the sheet shows the scope summary', /scopeSummary\(\{/.test(stylesSource));
check('the sheet renders the "only one thing changes" block',
  /inspector__scope/.test(stylesSource));
check('the strip renders the receipt rows', /receiptRows\(receipt\)/.test(stylesSource));
check('the strip offers Undo all', /Undo all/.test(stylesSource));

// ---- mobile-first invariants ------------------------------------------

const stripRule = /\.inspector__receipt-row \{([\s\S]*?)\}/.exec(css);
check('receipt rows are 44 px targets', !!stripRule && /min-height:\s*var\(--tap\)/.test(stripRule[1]), stripRule ? stripRule[1].slice(0, 60) : 'no rule');
check('the strip does not scroll horizontally',
  !/\.inspector__receipt[^{]*\{[^}]*overflow-x:\s*(auto|scroll)/.test(css));
check('the scope block is styled', /\.inspector__scope \{/.test(css));
check('a kept declaration is marked as such', /inspector__scope-kept/.test(css) || /KEPT/.test(stylesSource));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' scope/receipt assertion(s) failed');
