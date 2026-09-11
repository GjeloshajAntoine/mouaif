'use strict';
// Regression test for the Styles panel "changed values come first" ordering.
//
// The panel lists an element's inline ("Declared styles") and resolved
// ("Computed") properties. The computed list is a ~400-row alphabetical wall,
// so a property the user just edited was impossible to find again. Edited
// properties are therefore tracked by name and hoisted to the top of both
// lists, most recently changed first, and highlighted by the row class the
// panel applies. This test locks in the ordering (including that untouched
// rows keep their original order) and the mark/unmark lifecycle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/stylesOrder.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const context = vm.createContext({});
vm.runInContext(source, context);
const { markChanged, unmarkChanged, orderChangedFirst, isChanged } = context;

// --- changedSet lifecycle --------------------------------------------------
assert.deepStrictEqual(Array.from(markChanged([], 'color')), ['color'], 'first change is recorded');
assert.deepStrictEqual(Array.from(markChanged(['color'], 'padding')), ['padding', 'color'],
  'the newest change goes to the front');
assert.deepStrictEqual(Array.from(markChanged(['padding', 'color'], 'color')), ['color', 'padding'],
  're-changing an existing property moves it to the front without duplicating');
assert.deepStrictEqual(Array.from(markChanged(['color'], '  ')), ['color'],
  'a blank property name is ignored');
// markChanged must not mutate the caller's array (Preact state updates rely
// on the new reference to re-render).
const original = ['a'];
markChanged(original, 'b');
assert.deepStrictEqual(Array.from(original), ['a'], 'markChanged leaves the input untouched');

assert.deepStrictEqual(Array.from(unmarkChanged(['padding', 'color'], 'padding')), ['color'],
  'removing a property drops its highlight');
assert.deepStrictEqual(Array.from(unmarkChanged(['color'], 'padding')), ['color'],
  'unmarking an unchanged property is a no-op');
assert.deepStrictEqual(Array.from(unmarkChanged(['color'], '')), ['color'], 'a blank name is ignored');

// --- ordering --------------------------------------------------------------
const rows = (...props) => props.map((prop) => ({ prop, value: prop + '-v' }));

// Untouched rows keep their incoming order (the computed list is already
// alphabetical; the inline list keeps its insertion order).
assert.deepStrictEqual(
  Array.from(orderChangedFirst(rows('a', 'b', 'c'), []).map((r) => r.prop)),
  ['a', 'b', 'c'],
  'with nothing changed the order is untouched');
assert.deepStrictEqual(
  Array.from(orderChangedFirst(rows('a', 'b', 'c'), ['x']).map((r) => r.prop)),
  ['a', 'b', 'c'],
  'a changed property absent from the rows changes nothing');

// Changed rows are hoisted, most recent first, and the rest follow in their
// original order — this is the actual bug being fixed.
assert.deepStrictEqual(
  Array.from(orderChangedFirst(rows('align-items', 'color', 'padding', 'z-index'), ['padding', 'color']).map((r) => r.prop)),
  ['padding', 'color', 'align-items', 'z-index'],
  'changed rows come first, most recent first');
assert.deepStrictEqual(
  Array.from(orderChangedFirst(rows('align-items', 'color', 'padding'), ['color', 'padding']).map((r) => r.prop)),
  ['color', 'padding', 'align-items'],
  'the most recently changed row is the very first row');

// orderChangedFirst must return a copy: the panel passes it the model's own
// arrays, and sorting those in place would corrupt the model on every render.
const input = rows('align-items', 'color');
const sorted = orderChangedFirst(input, ['color']);
assert.deepStrictEqual(Array.from(input.map((r) => r.prop)), ['align-items', 'color'],
  'the input array is not sorted in place');
assert.notStrictEqual(sorted, input, 'a new array is returned');
assert.deepStrictEqual(Array.from(sorted.map((r) => r.prop)), ['color', 'align-items'], 'the copy is ordered');

// A custom key lets a caller order by something other than `prop`.
assert.deepStrictEqual(
  Array.from(orderChangedFirst([{ k: 'a' }, { k: 'b' }], ['b'], (r) => r.k).map((r) => r.k)),
  ['b', 'a'],
  'a custom key function is honoured');

// Defensive: the panel may render before a model exists.
assert.deepStrictEqual(Array.from(orderChangedFirst(null, ['a'])), [], 'null rows yields an empty list');
assert.deepStrictEqual(Array.from(orderChangedFirst(rows('a'), null).map((r) => r.prop)), ['a'],
  'a null changed list leaves the order alone');

// --- membership ------------------------------------------------------------
assert.strictEqual(isChanged(['color'], 'color'), true, 'a changed property is reported');
assert.strictEqual(isChanged(['color'], 'padding'), false, 'an unchanged property is not');
assert.strictEqual(isChanged(null, 'color'), false, 'a missing list is tolerated');

// --- the panel actually uses this ordering --------------------------------
// Guards against the helper being orphaned: the ordering is worthless if the
// render path stops calling it.
const panel = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/StylesPanel.jsx'), 'utf8');
assert.ok(/import \{[^}]*orderChangedFirst[^}]*\} from '\.\/stylesOrder\.js'/.test(panel),
  'StylesPanel imports orderChangedFirst');
assert.ok(/orderChangedFirst\(inlineRows, changed\)/.test(panel),
  'the declared list is ordered with the change set');
assert.ok(/orderChangedFirst\(computedRows, changed\)/.test(panel),
  'the computed list is ordered with the change set');
assert.ok(/declaredRows\.map/.test(panel) && /computedPage\.map/.test(panel),
  'both lists render the ordered rows (the computed list renders the filtered+'
  + 'paged slice of orderedComputed, so changed rows still lead the visible list)');
assert.ok(/inspector__styles-row--changed/.test(panel),
  'changed rows carry the highlight class');
// The highlight is only honest if the hoisted rows show the value that was
// actually applied: the panel re-reads the element after every edit, and
// clears the set when a different element is selected.
assert.ok(/applyEdit[\s\S]*?await syncFromPage\(\)/.test(panel),
  'an applied edit re-reads the element so the changed rows are current');
assert.ok(/removeEdit[\s\S]*?await syncFromPage\(\)/.test(panel),
  'a removed property re-reads the element too');
assert.ok(/m\.objectId !== prevId\)[\s\S]{0,80}setChanged\(\[\]\)/.test(panel),
  'selecting a different element clears the change set');
// …and the receipt with it: its entries name properties of the element that was
// selected, so undoing them against a new element would be a write to the wrong
// node.
assert.ok(/m\.objectId !== prevId\)[\s\S]{0,120}props\.onSelectionReset/.test(panel),
  'selecting a different element clears the session receipt');

console.log('PASS inspector styles changed-first ordering (mark/unmark, hoist, stable remainder, highlighted rows)');
