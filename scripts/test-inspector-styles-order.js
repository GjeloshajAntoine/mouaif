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
// The declared list is ordered after grouping (declaredGroups.js), keyed by the
// most recently changed member of each row, so a `border` row rises when one of
// its longhands was edited.
assert.ok(/orderChangedFirst\(groupedRows, changed, \(row\) => changedKey\(row, changed\)\)/.test(panel),
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
// clears the set when a different element is selected. The re-read goes through
// `revalidate` since R3, because the matched-rules entry carries the element's
// own `element.style` rule and a shorthand the CSSOM expanded is only findable
// through that (see the value-rail doc).
assert.ok(/applyEdit[\s\S]*?await revalidate\(\)/.test(panel),
  'an applied edit re-reads the element so the changed rows are current');
assert.ok(/removeEdit[\s\S]*?await revalidate\(\)/.test(panel),
  'a removed property re-reads the element too');
assert.ok(/function revalidate\(\)[\s\S]{0,200}await syncFromPage\(\)[\s\S]{0,200}loadRules\(/.test(panel),
  'the re-read covers both the inline declarations and the matched rules');
assert.ok(/const sameElement = !!\(m && m\.objectId === prevId\)/.test(panel),
  'the panel decides "same element" by comparing object ids');
assert.ok(/!sameElement\)[\s\S]{0,80}setChanged\(\[\]\)/.test(panel),
  'selecting a different element clears the change set');
// …and the receipt with it: its entries name properties of the element that was
// selected, so undoing them against a new element would be a write to the wrong
// node.
assert.ok(/!sameElement\)[\s\S]{0,140}props\.onSelectionReset/.test(panel),
  'selecting a different element clears the session receipt');
// The pinned element preview is never blanked on adoption: the capture for the
// new element is dispatched first and written into the same <img> node, so the
// previous picture stays painted while the new bytes decode instead of the strip
// going empty on every tap in the element tree.
assert.ok(/setModelBoth\(m\);\s*\nsetShotBusy\(false\);\s*\n\/\/ The preview is cleared only after/.test(panel),
  'the element preview is filled by the capture, not blanked on adoption');
assert.ok(!/setShot\(null\);\s*\nsetShotBusy\(false\);\s*\ncaptureShot\(\)/.test(panel),
  'adoption no longer clears the preview before capturing');
// --- a shorthand edit marks the longhands it wrote -------------------------
// The rows the lists carry are the element's own declarations, and the CSSOM
// expands every shorthand when it lands (`padding: 30px` is stored as four
// longhands). Marking the typed name alone therefore highlighted and hoisted
// nothing for `margin`, `padding` or `border` — the three shorthand quick-add
// chips. The set is the names the page reports after the read, so the mark
// happens *after* `revalidate()` and never before it.
assert.ok(/import \{[^}]*writtenNames[^}]*\} from '\.\/shorthand\.js'/.test(panel),
  'StylesPanel takes the written-name expansion from shorthand.js');
assert.ok(/function changedNamesFor\(prop\)[\s\S]{0,400}writtenNames\(prop/.test(panel),
  'the changed set is built from the names the element actually carries');
assert.ok(/function markWritten\(prop\)[\s\S]{0,400}setChanged/.test(panel),
  'marking a written edit goes through one helper');
// The mark is only as good as the list it is read from. Both readers of
// `modelRef.current` run *after* a write — the changed-row marks ask it which
// names were written, and applyEdit takes the value an undo must restore from it
// — and the ref used to keep whatever the element had when it was picked. A
// shorthand applied to an element with no inline styles therefore marked nothing
// (its longhands were not in the stale list), which is the same missing highlight
// this test exists to prevent, one layer down.
assert.ok(/function setModelBoth\(next\)\s*\{\s*modelRef\.current = next;\s*setModel\(next\);\s*\}/.test(panel),
  'the model and the ref are written by one helper');
assert.ok(/function upsertLocal\(prop, value, priority\)[\s\S]{0,500}setModelBoth\(/.test(panel),
  'an optimistic local write updates the ref too');
assert.ok(/function applyInlineSnapshot\(snapshot\)[\s\S]{0,1600}setModelBoth\(/.test(panel),
  'the post-edit snapshot updates the ref, so the next reader sees the page as it now is');
assert.ok(/async function applyEdit[\s\S]{0,2000}setModelBoth\(m\)|setModelBoth\(m\)/.test(panel),
  'a freshly built node model goes through the same helper');
assert.ok(/applyEdit[\s\S]*?await revalidate\(\);[\s\S]{0,900}?markWritten\(prop\)/.test(panel),
  'an applied edit marks what the page wrote, after the re-read');
assert.ok(!/setChanged\(\(prev\) => markChanged\(prev, prop\)\)/.test(panel),
  'the old exact-name marking is gone — it is what left a shorthand unhighlighted');
assert.ok(/removeEdit[\s\S]{0,900}?changedNamesFor\(prop\)[\s\S]{0,900}?unmarkChanged/.test(panel),
  'a removal drops the highlight for every name it took off the element');
assert.ok(/function noteUndone\(prop\)[\s\S]{0,600}changedNamesFor\(prop\)[\s\S]{0,400}unmarkChanged/.test(panel),
  'an undo from the receipt drops the whole group too');
// --- a changed row is also the way back into the editor --------------------
// In the Computed list the highlight is what makes a row findable, and it is
// the only row in that read-only wall that opens the value sheet — on the value
// the page reports *now*, since the hoisted row is re-read after every edit.
assert.ok(/const changedRow = isChanged\(changed, row\.prop\)/.test(panel),
  'the computed render asks per row whether it changed');
assert.ok(/changedRow[\s\S]{0,400}h\('button'[\s\S]{0,300}class: 'inspector__styles-row-main'/.test(panel),
  'a changed computed row is rendered as an editor button');
assert.ok(/setEdit\(\{ prop: row\.prop, value: row\.value \}\)/.test(panel),
  'opening it carries the computed value into the sheet');
assert.ok(/isChanged\(changed, row\.prop\) \? ' inspector__styles-row--changed'/.test(panel)
  || /changedRow \? ' inspector__styles-row--changed'/.test(panel),
  'the highlight class is still applied from the same predicate as the button');

console.log('PASS inspector styles changed-first ordering (mark/unmark, hoist, stable remainder, highlighted rows)');
