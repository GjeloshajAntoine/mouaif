'use strict';
// Inspector shorthand write-back (Part R3).
//
// A fan-out edit drags four sides and has to write back the *shortest valid*
// form: four equal values are one value, an opposite pair is two, and so on. It
// also has to know when it may not collapse at all — a `var()` side would make
// the whole shorthand invalid at computed-value time, and a value containing
// whitespace would re-split into two sides. Both the collapse and the refusal
// are pure, and both are asserted here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
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
vm.runInContext(strip(read('frontend/src/components/inspector/shorthand.js'))
+ '\n;globalThis.SH = { collapse, shorthandFor, shorthandWrites, writesProperty, writtenNames, toRoot, fromRoot, asRem, asPx };\n', ctx);
const SH = ctx.SH;
check('the module loads', !!SH && typeof SH.shorthandFor === 'function');
// ---- collapse: the four shorthand rules ---------------------------------
check('four equal values collapse to one', SH.collapse(['10px', '10px', '10px', '10px'], 4) === '10px');
check('an opposite pair collapses to two', SH.collapse(['10px', '20px', '10px', '20px'], 4) === '10px 20px');
check('an opposite pair made of one value collapses to one', SH.collapse(['8px', '8px', '8px', '8px'], 4) === '8px');
check('a matching left and right gives three', SH.collapse(['4px', '8px', '12px', '8px'], 4) === '4px 8px 12px');
check('four distinct values stay four', SH.collapse(['1px', '2px', '3px', '4px'], 4) === '1px 2px 3px 4px');
// A pair of pairs (top == bottom, left == right) is *not* collapsible to two:
// two values mean (top right), which would be a different declaration.
check('a pair of pairs that is not opposite stays four',
SH.collapse(['8px', '8px', '12px', '12px'], 4) === '8px 8px 12px 12px',
SH.collapse(['8px', '8px', '12px', '12px'], 4));
check('a two-side property collapses when equal', SH.collapse(['12px', '12px'], 2) === '12px');
check('a two-side property stays a pair when not', SH.collapse(['12px', '24px'], 2) === '12px 24px');
check('an incomplete set does not collapse', SH.collapse(['1px', '2px'], 4) === null);
check('an empty value does not collapse', SH.collapse(['1px', '', '3px', '4px'], 4) === null);
check('a null list does not collapse', SH.collapse(null, 4) === null);
check('a single-element set does not collapse', SH.collapse(['1px'], 1) === null);
// ---- shorthandFor: the write-back --------------------------------------
{
const r = SH.shorthandFor('padding', { top: '10px', right: '14px', bottom: '18px', left: '14px' });
check('a fan-out reports the shorthand form', r.ok === true && r.form === 'shorthand', JSON.stringify(r));
check('the shorthand is the shortest form', r.value === '10px 14px 18px', r.value);
check('the longhands are still available', r.longhands['padding-top'] === '10px' && r.longhands['padding-left'] === '14px');
check('nothing is refused without a reason', r.reason === '');
}
{
const writes = SH.shorthandWrites('padding', { top: '8px', right: '8px', bottom: '8px', left: '8px' });
check('an equal fan-out writes one declaration', writes.length === 1 && writes[0].prop === 'padding', JSON.stringify(writes));
check('and it is the single value', writes[0].value === '8px', writes[0].value);
}
{
// A `var()` side cannot be folded: an unresolvable custom property invalidates
// the whole shorthand at computed-value time, so one missing variable would
// take all four sides with it.
const r = SH.shorthandFor('padding', { top: 'var(--space-3)', right: 'var(--space-3)', bottom: 'var(--space-3)', left: 'var(--space-3)' });
check('a var() fan-out is written as longhands', r.form === 'longhands', JSON.stringify(r));
check('the refusal is explained', /custom property/.test(r.reason), r.reason);
const writes = SH.shorthandWrites('padding', { top: 'var(--space-3)', right: 'var(--space-3)', bottom: 'var(--space-3)', left: 'var(--space-3)' });
check('it writes four declarations', writes.length === 4, JSON.stringify(writes));
check('each one is the longhand', writes.map((w) => w.prop).join(',') === 'padding-top,padding-right,padding-bottom,padding-left', JSON.stringify(writes.map((w) => w.prop)));
}
check('an env() side is refused too',
SH.shorthandFor('padding', { top: 'env(safe-area-inset-top)', right: '0px', bottom: '0px', left: '0px' }).form === 'longhands');
check('an attr() side is refused too',
SH.shorthandFor('padding', { top: 'attr(data-x)', right: '0px', bottom: '0px', left: '0px' }).form === 'longhands');
// A `calc()` is one token to a shorthand parser only because it is parenthesised.
check('a parenthesised calc() may join a shorthand',
SH.shorthandFor('padding', { top: 'calc(1px + 2px)', right: '4px', bottom: 'calc(1px + 2px)', left: '4px' }).form === 'shorthand');
{
const r = SH.shorthandFor('padding', { top: 'calc(1px + 2px)', right: '4px', bottom: 'calc(1px + 2px)', left: '4px' });
check('and it collapses with the calc intact', r.value === 'calc(1px + 2px) 4px', r.value);
}
check('a bare two-token value is refused',
SH.shorthandFor('padding', { top: '1px 2px', right: '0', bottom: '0', left: '0' }).form === 'longhands');
check('a keyword side is allowed',
SH.shorthandFor('padding', { top: 'inherit', right: 'inherit', bottom: 'inherit', left: 'inherit' }).value === 'inherit');
check('a mixed keyword and length collapses',
SH.shorthandFor('padding', { top: '0', right: 'auto', bottom: '0', left: 'auto' }).value === '0 auto');
// ---- border-radius: the slash form --------------------------------------
{
const corners = { 'top-left': '8px', 'top-right': '8px', 'bottom-right': '12px', 'bottom-left': '12px' };
const r = SH.shorthandFor('border-radius', corners);
check('four corners collapse to a shorthand', r.form === 'shorthand', JSON.stringify(r));
check('the corners collapse to their longest form when they must', r.value === '8px 8px 12px 12px', r.value);
// The corners that *do* collapse to the two-value form: this is the case the
// slash rule exists for.
const pair = SH.shorthandFor('border-radius', { 'top-left': '4px', 'top-right': '8px', 'bottom-right': '4px', 'bottom-left': '8px' });
check('a corner pair is written as longhands', pair.form === 'longhands', JSON.stringify(pair));
check('because the space-separated pair means the slash form', /slash form/.test(pair.reason), pair.reason);
check('the corners are named as longhands',
pair.longhands['border-top-left-radius'] === '4px' && pair.longhands['border-top-right-radius'] === '8px',
JSON.stringify(pair.longhands));
const opposite = SH.shorthandFor('border-radius', { 'top-left': '8px', 'top-right': '4px', 'bottom-right': '8px', 'bottom-left': '4px' });
check('the radius pair that would be the slash form is written as longhands',
opposite.form === 'longhands', JSON.stringify(opposite));
const equal = SH.shorthandFor('border-radius', { 'top-left': '8px', 'top-right': '8px', 'bottom-right': '8px', 'bottom-left': '8px' });
check('four equal corners write one value', equal.form === 'shorthand' && equal.value === '8px', JSON.stringify(equal));
}
// ---- the two-side properties -------------------------------------------
{
const gap = SH.shorthandFor('gap', { row: '12px', column: '12px' });
check('an equal gap writes one value', gap.form === 'shorthand' && gap.value === '12px', JSON.stringify(gap));
check('and its longhands are the block ones', gap.longhands['row-gap'] === '12px' && gap.longhands['column-gap'] === '12px');
const two = SH.shorthandFor('gap', { row: '12px', column: '24px' });
check('an unequal gap writes a pair', two.value === '12px 24px', two.value);
}
// ---- missing values and the wrong property -----------------------------
{
const missing = SH.shorthandFor('padding', { top: '4px' });
check('a missing side is refused', missing.ok === false, JSON.stringify(missing));
check('and the refusal names the side', /right/.test(missing.reason), missing.reason);
check('a non-shorthand property is refused', SH.shorthandFor('color', { top: '4px' }).ok === false);
check('a refused write produces nothing', SH.shorthandWrites('color', { top: '4px' }).length === 0);
check('an unknown property produces nothing', SH.shorthandWrites('grid-template-columns', {}).length === 0);
}
// ---- the round trip ----------------------------------------------------
{
// Split a shorthand, then write it back: the writer must produce a value that
// re-splits to the same four sides.
const cases = [
['padding', '10px'],
['padding', '10px 14px'],
['padding', '10px 14px 18px'],
['padding', '10px 14px 18px 14px'],
['margin', '8px 16px'],
['inset', '0px'],
['border-radius', '8px 8px 12px 12px'],
['gap', '12px'],
['gap', '12px 24px']
];
for (const [prop, value] of cases) {
const split = ctx.splitSides(prop, value);
const written = SH.shorthandFor(prop, split.sides);
const again = ctx.splitSides(prop, written.value);
const same = split.sides && again.sides
&& Object.keys(split.sides).every((k) => split.sides[k] === again.sides[k]);
check('the round trip preserves ' + prop + ': ' + value, same,
JSON.stringify({ split: split.sides, written: written.value, again: again.sides }));
}
// A value that cannot legally collapse keeps its longhands, and those longhands
// re-split to the same sides, so the page reads back what the user dragged.
const varCase = { top: 'var(--a)', right: 'var(--a)', bottom: 'var(--a)', left: 'var(--a)' };
const r = SH.shorthandFor('padding', varCase);
check('the longhand fallback carries every side',
Object.values(r.longhands).every((v) => v === 'var(--a)'), JSON.stringify(r.longhands));
}
// ---- the unit round trip, off a non-16px root --------------------------
{
check('a px value becomes rem against a 20 px root', SH.asRem(16, 20) === '0.8rem', SH.asRem(16, 20));
check('a px value becomes rem against a 16 px root', SH.asRem(16, 16) === '1rem', SH.asRem(16, 16));
check('a px value becomes rem against a 12 px root', SH.asRem(18, 12) === '1.5rem', SH.asRem(18, 12));
check('rem becomes px against a 20 px root', SH.asPx(0.8, 20) === '16px', SH.asPx(0.8, 20));
check('the conversion round-trips', SH.asPx(Number(SH.toRoot(24, 20)), 20) === '24px', SH.asPx(Number(SH.toRoot(24, 20)), 20));
check('toRoot returns the ratio, not a string', SH.toRoot(16, 20) === 0.8);
check('fromRoot returns the pixels', SH.fromRoot(0.8, 20) === 16);
check('an unknown root yields nothing rather than an assumed 16', SH.asRem(16, null) === null);
check('a zero root yields nothing', SH.asRem(16, 0) === null);
check('a negative root yields nothing', SH.asRem(16, -4) === null);
check('a non-number yields nothing', SH.asRem('auto', 16) === null);
check('a decimal root works', SH.asRem(18, 17.5) === '1.0286rem', SH.asRem(18, 17.5));
}
// ---- what a shorthand writes ------------------------------------------
// The Styles panel tracks an edit by the names the *element* carries after the
// write, because the CSSOM expands a shorthand into longhands and a shorthand
// is never a row in either list. Getting this wrong left every shorthand edit
// (margin, padding, border — three of the six quick-add chips) with no
// highlight and no hoist at all, so "what did I just change?" had no answer.
{
check('a property writes itself', SH.writesProperty('padding-top', 'padding-top') === true);
check('a property does not write a neighbour', SH.writesProperty('padding-top', 'padding-right') === false);
check('a prefix longhand is written by its shorthand',
SH.writesProperty('padding', 'padding-top') === true);
check('an unprefixed pair is written by its shorthand',
SH.writesProperty('border', 'border-top-width') === true);
check('background writes its longhands', SH.writesProperty('background', 'background-color') === true);
check('a fan-out side is written by its shorthand', SH.writesProperty('inset', 'top') === true);
check('border-width writes the per-side widths',
SH.writesProperty('border-width', 'border-top-width') === true);
check('border-radius writes its corners',
SH.writesProperty('border-radius', 'border-top-left-radius') === true);
check('gap writes the two axis gaps',
SH.writesProperty('gap', 'row-gap') === true && SH.writesProperty('gap', 'column-gap') === true);
check('the match is case-insensitive', SH.writesProperty('Padding', 'padding-top') === true);
check('a longhand does not write its shorthand', SH.writesProperty('padding-top', 'padding') === false);
check('a custom property writes only itself',
SH.writesProperty('--a', '--a-b') === false);
check('a blank name is never written', SH.writesProperty('padding', '') === false
&& SH.writesProperty('', 'padding-top') === false);
// writtenNames — the property first, then the longhands the page carries, and
// nothing that is not there.
check('the written names lead with the property itself',
JSON.stringify(SH.writtenNames('padding', ['padding-top', 'padding-right', 'color']))
=== JSON.stringify(['padding', 'padding-top', 'padding-right']),
JSON.stringify(SH.writtenNames('padding', ['padding-top', 'padding-right', 'color'])));
check('a property that was not expanded stands alone',
JSON.stringify(SH.writtenNames('background-color', ['background-color', 'color']))
=== JSON.stringify(['background-color']));
check('a missing name list yields the property alone',
JSON.stringify(SH.writtenNames('padding', null)) === JSON.stringify(['padding']));
check('a blank property yields nothing', SH.writtenNames('', ['padding-top']).length === 0);
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' shorthand assertion(s) failed');
