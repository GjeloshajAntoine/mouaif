'use strict';
// Inspector snapping — putting a value on the page's own scale.
//
// The value index reports the values a page uses for a property and the GCD
// step between them (valueIndex.js). This suite asserts the arithmetic that
// turns that step into guidance: an exact hit, an off-scale value with its
// honest distance, step selection, and the fallback when there is no scale —
// plus the one rule that matters most, that snapping is never silent.
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
vm.runInContext(strip(read('frontend/src/components/inspector/snapping.js'))
+ '\n;globalThis.SN = { MIN_STEP, roundTo, usableScale, isOnScale, nearestOnScale, stepFor, stepValue, snapValue, snapNote, scaleStepFor };\n', ctx);
const SN = ctx.SN;
// A 4 px design scale, exactly as numericScale reports one for 4/8/16 px values.
const SCALE = { unit: 'px', values: [4, 8, 16], step: 4, decimals: 0 };
check('the module loads', !!SN && typeof SN.snapValue === 'function');
// ---- usableScale -------------------------------------------------------
check('a scale with two values and a step is usable', SN.usableScale(SCALE) === true);
check('a single value is not a scale',
SN.usableScale({ unit: 'px', values: [16], step: null }) === false);
check('a scale without a step is not usable',
SN.usableScale({ unit: 'px', values: [4, 8], step: null }) === false);
check('no scale at all is not usable', SN.usableScale(null) === false);
check('a sub-pixel step is noise, not a scale',
SN.usableScale({ unit: 'px', values: [0.1, 0.2], step: 0.1 }) === false);
check('MIN_STEP is exported', SN.MIN_STEP === 0.5);
// ---- isOnScale ---------------------------------------------------------
check('an exact page value is on the scale', SN.isOnScale('16px', SCALE) === true);
check('the smallest page value is on the scale', SN.isOnScale('4px', SCALE) === true);
check('a value between the steps is off the scale',
SN.isOnScale('14px', SCALE) === false);
check('a multiple of the step that the page never uses is off the scale',
SN.isOnScale('12px', SCALE) === false);
check('0 is off a scale that does not contain it', SN.isOnScale('0px', SCALE) === false);
check('a bare number compares in the scale unit', SN.isOnScale('8', SCALE) === true);
check('another unit is off the scale',
SN.isOnScale('16rem', SCALE) === false);
check('a non-number is off the scale', SN.isOnScale('auto', SCALE) === false);
check('a decimal scale compares on its own precision',
SN.isOnScale('1.5', { unit: '', values: [1.5, 3], step: 1.5, decimals: 1 }) === true);
check('a decimal scale is not fooled by float noise',
SN.isOnScale('3', { unit: '', values: [1.5, 3], step: 1.5, decimals: 1 }) === true);
// ---- nearestOnScale ----------------------------------------------------
{
const n = SN.nearestOnScale('14px', SCALE);
check('the nearest value on the scale is named', n && n.number === 16, JSON.stringify(n));
check('the distance to it is honest', n && n.distance === 2, JSON.stringify(n));
check('the distance is readable', n && n.distanceText === '2px', JSON.stringify(n));
const low = SN.nearestOnScale('3px', SCALE);
check('a value below the scale snaps up to its first value', low.number === 4 && low.distance === 1);
const tie = SN.nearestOnScale('6px', SCALE);
check('a tie resolves to the lower value, so it is stable', tie.number === 4, JSON.stringify(tie));
check('an exact value has zero distance', SN.nearestOnScale('8px', SCALE).distance === 0);
check('no scale means no nearest value', SN.nearestOnScale('14px', null) === null);
check('a unit mismatch means no nearest value',
SN.nearestOnScale('14%', SCALE) === null);
// ---- stepFor / stepValue ----------------------------------------------
check('the page step wins the stepper', SN.stepFor(SCALE, undefined) === 4);
check('an explicit precision beats the page step', SN.stepFor(SCALE, 1) === 1);
check('no scale and no precision falls back to the caller default',
SN.stepFor(null, null) === null);
check('a step up uses the page step', SN.stepValue('14px', 1, 4) === '18px');
check('a step down uses the page step', SN.stepValue('14px', -1, 4) === '10px');
check('no step falls back to one', SN.stepValue('14px', 1, null) === '15px');
check('a nudge below zero clamps at zero', SN.stepValue('2px', -1, 4) === '0px');
check('the unit is preserved', SN.stepValue('0.5em', 1, 0.5) === '1em');
check('a float step formats as a human would type it',
SN.stepValue('1.5', 1, 1.5) === '3');
check('a non-number is not steppable', SN.stepValue('auto', 1, 4) === null);
}
// ---- snapValue ---------------------------------------------------------
{
const exact = SN.snapValue('padding', '16px', SCALE);
check('an exact hit is reported as on scale', exact.onScale === true && exact.offScale === false);
check('an exact hit is not rewritten', exact.snapped === false && exact.value === '16px');
check('an exact hit carries the step for the header', exact.step === 4);
check('an exact hit notes the step', SN.snapNote(exact) === 'on scale · 4 px step');
}
{
const off = SN.snapValue('padding', '13px', SCALE);
check('an off-scale value is reported as off scale', off.offScale === true);
check('an off-scale value keeps its own text when snapping was not asked for',
off.value === '13px' && off.snapped === false, JSON.stringify(off));
check('an off-scale value reports the nearest page value', off.nearest.value === '16px');
check('an off-scale value reports how far off it is', off.distance === 3);
check('the off-scale note names the nearest value and the distance',
SN.snapNote(off) === 'nearest 16px · 3px away', SN.snapNote(off));
check('snapping without a hint leaves the original as `from`', off.from === '13px' && off.to === '13px');
}
{
const asked = SN.snapValue('padding', '13px', SCALE, { snapTo: true });
check('an explicit snap rewrites the value', asked.value === '16px' && asked.snapped === true);
check('an explicit snap says so', /snapped to the nearest page value/.test(asked.reason), asked.reason);
check('the explicit snap note reports the step', SN.snapNote(asked) === 'snapped · 4 px step', SN.snapNote(asked));
check('the from/to pair is the honest before and after', asked.from === '13px' && asked.to === '16px');
}
{
const noScale = SN.snapValue('padding', '13px', null);
check('no scale leaves the value alone', noScale.value === '13px' && noScale.snapped === false);
check('no scale is reported, not guessed at', /no numeric scale/.test(noScale.reason), noScale.reason);
check('no scale is not called off-scale', noScale.offScale === false);
const same = SN.snapValue('padding', '13px', SCALE, { snapTo: true });
check('snapping an exact value is a no-op', SN.snapValue('padding', '16px', SCALE, { snapTo: true }).value === '16px');
check('a unit outside the scale is left alone with a reason',
SN.snapValue('padding', '50%', SCALE).offScale === false
&& /scale is in px/.test(SN.snapValue('padding', '50%', SCALE).reason),
SN.snapValue('padding', '50%', SCALE).reason);
check('a non-numeric value is left alone with a reason',
SN.snapValue('display', 'flex', SCALE).reason === 'not a number');
check('an empty value has nothing to snap', SN.snapValue('padding', '', SCALE).reason === 'nothing to snap');
check('the property is named in the no-scale reason',
/padding/.test(SN.snapValue('padding', '13px', { unit: 'px', values: [13], step: null }).reason));
}
// ---- a log-free sanity check on the scale of the mock ------------------
{
// The K1 mock's rail: a 0…32 px range with a 4 px step, values 0/8/16/32 and a
// token at 14px. 14 is off the page's own scale and 2px from 16.
const mock = { unit: 'px', values: [0, 8, 16, 32], step: 4, decimals: 0 };
const result = SN.snapValue('padding', '14px', mock);
check('the mock value 14px reports nearest 16px, 2px away',
result.nearest.value === '16px' && SN.snapNote(result) === 'nearest 16px · 2px away',
SN.snapNote(result));
check('every mock tick is on the scale',
[0, 8, 16, 32].every((n) => SN.isOnScale(n + 'px', mock)));
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' snapping assertion(s) failed');
