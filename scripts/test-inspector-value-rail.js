'use strict';
// Inspector value rail — the arithmetic behind the drag.
//
// The rail is the sheet's numeric changer: one control for every numeric kind,
// with the page's own values as its ticks. Gesture handling is verified live;
// what is asserted here is the maths, because a rail whose mapping is not
// monotonic, whose endpoints are not exact, or whose step does not survive a
// round trip is a control that silently writes the wrong number.
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
function near(a, b, tol) {
return typeof a === 'number' && Math.abs(a - b) <= (tol == null ? 1e-9 : tol);
}
const ctx = vm.createContext({});
vm.runInContext(strip(read('frontend/src/components/inspector/valueKinds.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/valueIndex.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/snapping.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/valueRail.js'))
+ '\n;globalThis.VR = { LOG_RATIO, MAX_TICKS, MAX_MAJOR, railRange, familyOf, valueToRatio, ratioToValue, quantize, snapStep, nudge, tickValues, majorValues, railTicks, railLabel, railWritable, isLogRange, fromUnit, unitEquivalent };\n', ctx);
const VR = ctx.VR;
check('the module loads', !!VR && typeof VR.railRange === 'function');
// ---- per-family ranges -------------------------------------------------
{
const pad = VR.railRange('padding', '16px', { size: 64 });
check('a length range is 0…4× the element size', pad.min === 0 && pad.max === 256, JSON.stringify(pad));
check('a length range reports its unit', pad.unit === 'px' && pad.family === 'length');
const rem = VR.railRange('padding', '1rem', { size: 64, rootFontSize: 16 });
check('a rem length range is expressed in rem', rem.unit === 'rem' && rem.max === 16, JSON.stringify(rem));
const noSize = VR.railRange('padding', '16px', {});
check('a length range falls back to a default box', noSize.max === 256, JSON.stringify(noSize));
const font = VR.railRange('padding', '16px', { fontSize: 18 });
check('the font size is the basis when there is no box size', font.max === 72, JSON.stringify(font));
check('opacity is 0…1',
JSON.stringify(VR.railRange('opacity', '0.5', {})) === JSON.stringify({ min: 0, max: 1, scale: 'linear', unit: '', family: 'opacity', step: null }),
JSON.stringify(VR.railRange('opacity', '0.5', {})));
const lh = VR.railRange('line-height', '1.5', {});
check('line-height is 0…3', lh.min === 0 && lh.max === 3);
const zi = VR.railRange('z-index', '3', {});
check('z-index starts below zero', zi.min === -10 && zi.max === 100);
const ang = VR.railRange('rotate', '12deg', {});
check('an angle is -180…180', ang.min === -180 && ang.max === 180 && ang.unit === 'deg');
check('a hue is 0…360',
VR.railRange('filter', 'hue-rotate(90deg)', {}).max === 360,
JSON.stringify(VR.railRange('filter', 'hue-rotate(90deg)', {})));
const time = VR.railRange('transition-duration', '180ms', {});
check('a time is 0…2000ms', time.min === 0 && time.max === 2000 && time.unit === 'ms');
const timeS = VR.railRange('transition-duration', '0.18s', {});
check('a time in seconds uses the same range in seconds', timeS.max === 2, JSON.stringify(timeS));
check('a percentage is 0…200', VR.railRange('width', '50%', {}).max === 200);
check('a scale() is 0…3', VR.railRange('scale', '1.02', {}).family === 'scale');
// A value outside the family's bounds is always reachable: the range grows to
// include it rather than parking the thumb at an end and lying about it.
const big = VR.railRange('z-index', '400', {});
check('a value past the range extends it', big.max === 400, JSON.stringify(big));
check('the properties are named as expected', VR.familyOf('padding', '8px') === 'length'
&& VR.familyOf('opacity', '0.4') === 'opacity'
&& VR.familyOf('transition-delay', '50ms') === 'time');
}
// ---- monotonicity and endpoints ---------------------------------------
{
const ranges = [
VR.railRange('opacity', '0.5', {}),
VR.railRange('padding', '16px', { size: 64 }),
VR.railRange('z-index', '3', {}),
VR.railRange('rotate', '10deg', {}),
VR.railRange('transition-duration', '180ms', {}),
{ min: 1, max: 1000, scale: 'log', unit: 'px', family: 'length', step: null }
];
for (const r of ranges) {
const name = r.family + ' ' + r.min + '…' + r.max + (r.scale === 'log' ? ' log' : '');
check('the start of the ' + name + ' rail is 0', near(VR.valueToRatio(r.min, r), 0));
check('the end of the ' + name + ' rail is 1', near(VR.valueToRatio(r.max, r), 1));
check('the ' + name + ' rail round-trips its start', near(VR.ratioToValue(0, r), r.min, 1e-6));
check('the ' + name + ' rail round-trips its end', near(VR.ratioToValue(1, r), r.max, 1e-6));
let prev = -Infinity;
let mono = true;
for (let i = 0; i <= 20; i++) {
const ratio = i / 20;
const v = VR.ratioToValue(ratio, r);
if (v < prev - 1e-9) mono = false;
prev = v;
}
check('the ' + name + ' rail is monotonic', mono);
const mid = VR.valueToRatio(VR.ratioToValue(0.5, r), r);
check('the ' + name + ' rail round-trips a midpoint', near(mid, 0.5, 1e-6), String(mid));
}
}
// ---- log scale ---------------------------------------------------------
{
const log = { min: 1, max: 1000, scale: 'log', unit: 'px', family: 'length', step: null };
check('a wide range is logarithmic', VR.isLogRange(log) === true);
check('the log midpoint is the geometric mean', near(VR.ratioToValue(0.5, log), Math.sqrt(1000), 1e-2),
String(VR.ratioToValue(0.5, log)));
check('a range starting at zero is never log',
VR.isLogRange({ min: 0, max: 10000, scale: 'linear' }) === false);
check('a range under the ratio threshold stays linear',
VR.railRange('padding', '16px', { size: 64 }).scale === 'linear');
check('a 1…1000 range becomes log', VR.LOG_RATIO === 100);
check('the log rail labels its ends', VR.railLabel(1, log) === '1px' && VR.railLabel(1000, log) === '1000px');
}
// ---- clamping ----------------------------------------------------------
{
const r = VR.railRange('opacity', '0.5', {});
check('a value below the range clamps to 0 in ratio', VR.valueToRatio(-5, r) === 0);
check('a value above the range clamps to 1 in ratio', VR.valueToRatio(99, r) === 1);
check('a ratio below zero clamps to the minimum', VR.ratioToValue(-1, r) === 0);
check('a ratio above one clamps to the maximum', VR.ratioToValue(2, r) === 1);
check('a non-number ratio is safe', VR.ratioToValue(NaN, r) === 0);
check('a non-number value is safe', VR.valueToRatio('auto', r) === 0);
check('no range is safe', VR.valueToRatio(1, null) === 0 && VR.ratioToValue(0.5, null) === 0);
check('quantize clamps without a step', VR.quantize(500, null, r) === 1);
check('quantize respects the step', VR.quantize(0.37, 0.05, r) === 0.35);
check('quantize at the top stays in range', VR.quantize(0.99, 0.05, r) === 1);
check('a float step does not leave noise', VR.quantize(1 / 3, 1 / 3, { min: 0, max: 1 }) === 0.3333);
}
// ---- step selection and the nudge pair ---------------------------------
{
check('a small value takes the fine step', VR.snapStep(4, { fine: 1, coarse: 4 }) === 1);
check('a larger value takes the coarse step', VR.snapStep(40, { fine: 1, coarse: 4 }) === 4);
check('the threshold is inclusive', VR.snapStep(16, { fine: 1, coarse: 4 }) === 1);
check('one step past the threshold goes coarse', VR.snapStep(16.1, { fine: 1, coarse: 4 }) === 4);
check('a fine-only caller gets the fine step', VR.snapStep(100, { fine: 0.5 }) === 0.5);
check('a coarse-only caller gets the coarse step', VR.snapStep(1, { coarse: 4 }) === 4);
check('no steps falls back to neither', VR.snapStep(1, {}) === null);
const r = VR.railRange('padding', '16px', { size: 64, step: 4 });
check('the page step is carried on the range', r.step === 4);
check('a nudge up uses the page step', VR.nudge(16, 1, 4, r) === 20);
check('a nudge down uses the page step', VR.nudge(16, -1, 4, r) === 12);
check('a nudge is clamped at the bottom', VR.nudge(0, -1, 4, r) === 0);
check('a nudge is clamped at the top', VR.nudge(r.max, 1, 4, r) === r.max);
check('a nudge without a step moves one', VR.nudge(10, 1, null, { min: 0, max: 100 }) === 11);
check('a nudge on a non-number starts at the minimum', VR.nudge('auto', 1, 4, { min: 8, max: 100 }) === 12);
}
// ---- ticks -------------------------------------------------------------
{
const r = VR.railRange('padding', '16px', { size: 64, step: 4 });
const minor = VR.tickValues(r, 4);
// A 0…256 range at a 4 px step is 65 ticks, which is below the rail's
// resolution on a phone: the step is widened to its first multiple that fits
// (8 px, 33 ticks here), keeping the ticks on multiples of the page's step.
check('the ticks are multiples of the page step', minor.every((v) => v % 4 === 0), minor.slice(0, 6).join(','));
check('the ticks start at the range minimum', minor[0] === 0);
check('a range too fine for its step is widened', minor.length <= VR.MAX_TICKS + 1, String(minor.length));
check('a coarse enough range keeps the page step exactly',
VR.tickValues({ min: 0, max: 32, scale: 'linear', unit: 'px', family: 'length', step: 4 }, 4).join(',') === '0,4,8,12,16,20,24,28,32',
VR.tickValues({ min: 0, max: 32, scale: 'linear', unit: 'px', family: 'length', step: 4 }, 4).join(','));
const many = VR.tickValues({ min: 0, max: 2000, scale: 'linear', unit: 'ms', family: 'time' }, 10);
check('a very wide range is widened further', many.length <= VR.MAX_TICKS + 1, String(many.length));
check('the widened ticks stay evenly spaced',
many.length > 2 && many.every((v, i) => i === 0 || near(v - many[i - 1], many[1] - many[0], 1e-9)),
many.slice(0, 5).join(','));
check('MAX_TICKS is a phone-sized cap', VR.MAX_TICKS === 40);
const spaced = VR.tickValues({ min: 0, max: 100, scale: 'linear', unit: '', family: 'number' }, null);
check('a range with no step gets ten ticks', spaced.length === 11, String(spaced.length));
check('ticks are empty without a range', VR.tickValues(null, 4).length === 0);
const majors = VR.majorValues(r);
check('the major ticks are round numbers', majors.every((v) => Number.isInteger(v)), majors.join(','));
check('the majors stay readable', majors.length <= VR.MAX_MAJOR + 1, majors.join(','));
check('a zero-span range is safe', VR.majorValues({ min: 5, max: 5 }).length === 1);
const ticks = VR.railTicks(r, {
step: 4,
tokens: [
{ name: '--space-3', value: '12px' },
{ name: '--space-9', value: '900px' },
{ name: '--percent', value: '50%' },
{ name: '--other', value: 'x' }
]
});
check('a token in range becomes a tick', ticks.tokens.length === 1, JSON.stringify(ticks.tokens));
check('the token tick names the token', ticks.tokens[0].name === '--space-3');
check('the token tick carries its ratio', near(ticks.tokens[0].ratio, 12 / 256, 1e-6));
check('a token outside the range is dropped',
!ticks.tokens.some((t) => t.name === '--space-9'));
check('a token in another unit is dropped',
!ticks.tokens.some((t) => t.name === '--percent'));
check('an unparsable token is dropped', !ticks.tokens.some((t) => t.name === '--other'));
check('the ticks come with the minors and majors',
ticks.minor.length > 1 && ticks.major.length >= 2);
check('a duplicate token value is not ticked twice',
VR.railTicks(r, { tokens: [{ name: '--a', value: '12px' }, { name: '--b', value: '12px' }] }).tokens.length === 1);
check('tokens are optional', VR.railTicks(r, {}).tokens.length === 0);
}
// ---- formatting round trip ---------------------------------------------
{
const r = VR.railRange('padding', '16px', { size: 64, step: 4 });
for (const v of [0, 4, 8, 16, 100, 256]) {
const label = VR.railLabel(v, r);
const back = Number(String(label).replace(/[a-z%]+$/i, ''));
check('the label round-trips ' + v, near(back, v, 1e-9), label);
}
check('a whole number has no decimal point', VR.railLabel(16, r) === '16px');
check('a fractional value is trimmed', VR.railLabel(1.5, { unit: '' }) === '1.5');
check('no value reads as nothing', VR.railLabel(null, r) === '' && VR.railLabel('', r) === '');
check('an unparsable value is passed through', VR.railLabel('auto', r) === 'auto');
}
// ---- the fallback ladder's last rung -----------------------------------
{
check('a length is draggable', VR.railWritable('padding', '16px').ok === true);
check('a number is draggable', VR.railWritable('opacity', '0.5').ok === true);
check('an angle is draggable', VR.railWritable('rotate', '12deg').ok === true);
const keyword = VR.railWritable('display', 'flex');
check('a keyword is not draggable', keyword.ok === false);
check('the reason explains why there is no rail', /not a number/.test(keyword.reason), keyword.reason);
check('a colour is not draggable', VR.railWritable('color', '#fff').ok === false);
check('an expression is not draggable', VR.railWritable('padding', 'calc(100% - 2px)').ok === false);
check('an empty value is not draggable', VR.railWritable('padding', '').ok === false);
}
// ---- unit basis --------------------------------------------------------
{
check('px needs no base', VR.fromUnit(16, 'px', {}) === 16);
check('rem resolves through the root', VR.fromUnit(2, 'rem', { rootFontSize: 16 }) === 32);
check('em resolves through the parent', VR.fromUnit(2, 'em', { parentFontSize: 18 }) === 36);
check('vh resolves through the viewport', VR.fromUnit(50, 'vh', { viewportHeight: 800 }) === 400);
check('a missing base falls back to the number', VR.fromUnit(2, 'rem', {}) === 2);
}
// ---- the mock's rail, end to end ---------------------------------------
{
// K1: a 0…32 px rail, a 4 px step, page values 0/8/16/32 and a token at 14px.
const range = { min: 0, max: 32, scale: 'linear', unit: 'px', family: 'length', step: 4 };
check('the mock rail puts 14px at 44%', near(VR.valueToRatio(14, range), 0.4375, 1e-9));
check('the mock rail puts the token a touch left of 16px',
VR.valueToRatio(14, range) < VR.valueToRatio(16, range));
check('dragging to 44% writes 14px', VR.ratioToValue(0.4375, range, 1) === 14);
check('dragging with the 4px step snaps to 16px', VR.ratioToValue(0.4375, range, 4) === 16);
check('the 0/8/16/32 ticks all land on the rail',
[0, 8, 16, 32].every((n) => VR.valueToRatio(n, range) >= 0 && VR.valueToRatio(n, range) <= 1));
check('the readout matches the mock', VR.railLabel(14, range) === '14px');
}
// ---- the footer's converted equivalent (K1's `= 0.875rem`) --------------
{
const U = ctx.unitOptions;
const px = U('padding', '14px', { rootFontSize: 16, parentFontSize: 16, fontSize: 16 });
const rem = px.find((o) => o.unit === 'rem');
check('14px converts to 0.875rem', rem && rem.ok && rem.value === '0.875rem', rem && rem.value);
check('the equivalent is the first convertible other unit',
VR.unitEquivalent(px) === '0.875rem', VR.unitEquivalent(px));
check('the unit in use is never the equivalent itself',
VR.unitEquivalent([{ unit: 'px', value: '14px', current: true, ok: true }]) === '');
check('a unit the inspector cannot resolve is skipped',
VR.unitEquivalent([
{ unit: 'em', value: '', ok: false, reason: 'needs the em base font size' },
{ unit: 'rem', value: '0.875rem', ok: true }
]) === '0.875rem');
check('no alternatives means no readout', VR.unitEquivalent([]) === '');
check('a missing option list means no readout', VR.unitEquivalent(undefined) === '');
// The readout is only useful if the component draws it: the chips would
// otherwise be the only place the conversion exists, one tap away.
const railSrc = read('frontend/src/components/inspector/ValueRail.jsx');
check('the rail renders the equivalent', /inspector__rail-equiv/.test(railSrc)
&& /unitEquivalent\(units\)/.test(railSrc));
check('the equivalent is styled', /\.inspector__rail-equiv \{/.test(read('frontend/src/inspector.css')));
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' value-rail assertion(s) failed');
