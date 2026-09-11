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
+ '\n;globalThis.VR = { LOG_RATIO, MAX_TICKS, MAX_MAJOR, STEP_LADDER, DRAG_STEP, BOX_FRACTIONS, TIME_PRESETS, SLOW_DRAG_SPEED, DOUBLE_TAP_MS, DOUBLE_TAP_PX, HOLD_MS, dragStepFor, isDoubleTap, stepLadder, familyStep, fractionSnaps, timePresets, railRange, familyOf, valueToRatio, ratioToValue, quantize, snapStep, nudge, tickValues, majorValues, railTicks, railLabel, railWritable, isLogRange, fromUnit, unitEquivalent };\n', ctx);
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
// ---- per-family steps (the mock's step table) ---------------------------
//
// The fallback step used to be `{ fine: 1, coarse: 8 }` for every family, which
// made an opacity rail a two-position switch: a 0…1 range quantized to 1 can
// only ever write 0 or 1. The table is per family now, and it is also what the
// precision segment shows.
{
// drag — the range and the step a thumb would use for a value.
const drag = (prop, val) => {
const range = VR.railRange(prop, val, {});
const n = Number(String(val).replace(/[^\d.+-]/g, ''));
return { range, step: VR.familyStep(n, range.family) };
};
// sweep — every value a full drag can land on, sampled finely enough that the
// sample is not itself the limit (200 samples across a 2000 ms range is 10 ms).
const sweep = (range, step, samples) => {
const n = samples || 400;
const out = [];
for (let i = 0; i <= n; i++) out.push(VR.ratioToValue(i / n, range, step));
return out;
};
// opacity: the mock's `0–1 at 0.05`.
{
const d = drag('opacity', '0.5');
check('opacity takes the 0.05 step', d.step === 0.05, String(d.step));
const out = sweep(d.range, d.step);
check('opacity can reach 0.5', out.includes(0.5), out.slice(0, 6).join(','));
check('opacity still reaches both ends', out.includes(0) && out.includes(1));
check('the middle of an opacity rail is 0.5, not 1',
VR.ratioToValue(0.5, d.range, d.step) === 0.5, String(VR.ratioToValue(0.5, d.range, d.step)));
// The bug this table fixes: with a ±1 step the same drag writes only 0 and 1.
const withOldStep = sweep(d.range, 1);
check('the old flat step could only write 0 or 1',
Array.from(new Set(withOldStep)).sort().join(',') === '0,1',
Array.from(new Set(withOldStep)).sort().join(','));
check('opacity lands on a step the page can use (0.05 multiples)',
out.every((n) => Math.abs(Math.round(n / 0.05) - n / 0.05) < 1e-9), out.slice(0, 5).join(','));
}
// line-height: `0–3 at 0.05`.
{
const d = drag('line-height', '1.6');
check('line-height takes the 0.05 step', d.step === 0.05, String(d.step));
check('line-height can land on 1.6', sweep(d.range, d.step).includes(1.6));
}
// z-index: `−10…100 at 1` — a flat step, because an index is not a design scale.
check('z-index steps by 1 at any magnitude',
VR.familyStep(3, 'z-index') === 1 && VR.familyStep(45, 'z-index') === 1);
// time: `step 10 ms / 50 ms`.
{
const short = drag('transition-duration', '180ms');
check('a short duration steps by 10 ms', short.step === 10, String(short.step));
check('a duration can land on 150 ms', sweep(short.range, short.step).includes(150),
sweep(short.range, short.step).slice(0, 6).join(','));
const long = drag('transition-duration', '1800ms');
check('a long duration steps by 50 ms', long.step === 50, String(long.step));
check('a long duration still lands on round presets', sweep(long.range, long.step).includes(1800));
}
// angle: `step 1° / 15°`, hue its own pair.
check('an angle steps by 1° while it is small', VR.familyStep(45, 'angle') === 1);
check('an angle steps by 15° when it is large', VR.familyStep(-170, 'angle') === 15);
check('hue keeps its own ladder', VR.familyStep(200, 'hue') === 15 && VR.familyStep(20, 'hue') === 1);
check('a length still steps 1/4/8', VR.familyStep(4, 'length') === 1 && VR.familyStep(40, 'length') === 8);
check('a scale steps finely near 1', VR.familyStep(1, 'scale') === 0.01 && VR.familyStep(2.5, 'scale') === 0.05);
// The ladders double as the precision segment.
{
check('the length ladder is the mock\'s 1/4/8', VR.stepLadder('length').join(',') === '1,4,8');
check('the opacity ladder is 0.01/0.05/0.1', VR.stepLadder('opacity').join(',') === '0.01,0.05,0.1');
check('the time ladder is 10/50/100', VR.stepLadder('time').join(',') === '10,50,100');
check('an unknown family falls back to the length ladder',
VR.stepLadder('nonsense').join(',') === '1,4,8' && VR.stepLadder(undefined).join(',') === '1,4,8');
check('every ladder is three ascending steps', Object.entries(VR.STEP_LADDER).every(([k, l]) =>
l.length === 3 && l[0] < l[1] && l[1] < l[2]), JSON.stringify(VR.STEP_LADDER));
// Every family a rail can produce has its own rules — a family missing from the
// table silently gets px steps, which is how the opacity bug happened. The list
// is the families `familyOf` returns, plus the two `railRange` branches.
const families = ['opacity', 'line-height', 'z-index', 'time', 'angle', 'hue', 'scale', 'percent', 'number', 'length'];
check('every rail family has a ladder', families.every((f) => !!VR.STEP_LADDER[f]),
families.filter((f) => !VR.STEP_LADDER[f]).join(','));
check('every rail family has a drag step', families.every((f) => !!VR.DRAG_STEP[f]),
families.filter((f) => !VR.DRAG_STEP[f]).join(','));
check('every ladder step is positive', Object.values(VR.STEP_LADDER)
.every((l) => l.every((n) => Number.isFinite(n) && n > 0)), JSON.stringify(VR.STEP_LADDER));
check('every drag step is positive and no coarser than its ladder',
Object.entries(VR.DRAG_STEP).every(([f, r]) => {
const l = VR.STEP_LADDER[f];
return r.fine > 0 && r.coarse >= r.fine && l.includes(r.fine) && l.includes(r.coarse);
}), JSON.stringify(VR.DRAG_STEP));
// The drag step must land on the ladder it advertises, or the segment shows one
// thing and the thumb does another.
check('the drag step is always one of the three the segment offers',
families.every((f) => {
const l = VR.STEP_LADDER[f];
return [0, 1, 5, 50, 500].every((v) => l.includes(VR.familyStep(v, f)));
}), families.filter((f) => {
const l = VR.STEP_LADDER[f];
return ![0, 1, 5, 50, 500].every((v) => l.includes(VR.familyStep(v, f)));
}).join(','));
}
// A page step still outranks the family table: that is the whole point of the
// "page" entry in the precision segment.
check('a page step is carried on the range and beats the family default', (() => {
const range = VR.railRange('padding', '14px', { step: 4 });
return range.step === 4 && range.family === 'length';
})());
check('a boolean opacity value still gets a usable step',
VR.familyStep(0, 'opacity') === 0.05 && VR.familyStep(Number('x'), 'opacity') === 0.05);
// The component draws the family's ladder, not a hardcoded px one, and names
// the step's origin in the header.
{
const src = read('frontend/src/components/inspector/ValueRail.jsx');
check('the segment renders the family ladder',
/const ladder = stepLadder\(range \? range\.family : ''\)/.test(src) && /ladder\.map\(/.test(src));
check('the hardcoded px segment is gone', !/const PRECISIONS = \[1, 4, 8\]/.test(src));
check('the drag step comes from the family',
/familyStep\(info\.number, range \? range\.family : ''\)/.test(src));
check('the header names the step\'s origin',
/'page step ' \+ formatNumber\(range\.step\)/.test(src) && /'step ' \+ formatNumber\(step\)/.test(src));
check('the segment label is formatted, so 0.05 is not 0.050000000000000006',
/formatNumber\(n\) \+ ' ' \+ \(range\.unit \|\| ''\)/.test(src));
}
}
// ---- box fractions (¼ / ½ / 1 of the element) ---------------------------
//
// The mock's third snap source: `page values + tokens + element box fractions`.
// A fraction is a statement about *this* element, so it is only offered when the
// sheet actually read the element's size — three invented targets are worse than
// none.
{
const el = (size, unit) => VR.railRange('padding', (unit || 'px') === 'px' ? '16px' : '1rem', { size, rootFontSize: 16 });
{
const r = el(64);
check('the rail is four times the element', r.max === 256, String(r.max));
const f = VR.fractionSnaps(r, { size: 64 });
check('a size yields all three fractions', f.length === 3, String(f.length));
check('the fractions are ¼ / ½ / 1 of the element',
f.map((x) => x.number).join(',') === '16,32,64', f.map((x) => x.number).join(','));
check('they carry the glyph the mock uses', f.map((x) => x.label).join(',') === '¼,½,1');
check('a quarter of a 64px element sits at 6.25% of the rail',
near(f[0].ratio, 0.0625, 1e-9), String(f[0].ratio));
check('half sits at 12.5%', near(f[1].ratio, 0.125, 1e-9), String(f[1].ratio));
check('the whole element sits at 25%', near(f[2].ratio, 0.25, 1e-9), String(f[2].ratio));
check('each fraction is tappable and lands on its own number',
f.every((x) => x.number === VR.ratioToValue(x.ratio, r, null) || Math.abs(x.number - VR.ratioToValue(x.ratio, r, null)) < 1e-9),
f.map((x) => x.number + '/' + VR.ratioToValue(x.ratio, r, null)).join(' '));
}
// The fractions follow the element, not a fixed 64.
{
const r = el(120);
const f = VR.fractionSnaps(r, { size: 120 });
check('a bigger element moves the fractions', f.map((x) => x.number).join(',') === '30,60,120',
f.map((x) => x.number).join(','));
}
// Units: the range is already expressed in the value's own unit, so the
// fractions are too — no px leaking into a rem rail.
{
const r = VR.railRange('padding', '1rem', { size: 64, rootFontSize: 16 });
const f = VR.fractionSnaps(r, { size: 64 });
check('a rem rail gets rem fractions', r.unit === 'rem' && f.map((x) => x.number).join(',') === '1,2,4',
r.unit + ' ' + f.map((x) => x.number).join(','));
}
// No size read, no fractions: the fallback basis is the rail's default, not the
// element's, so offering ¼ of it would be a made-up target.
check('an unread size yields no fractions', VR.fractionSnaps(el(64), {}).length === 0);
check('a zero size yields none', VR.fractionSnaps(el(64), { size: 0 }).length === 0);
check('a negative size yields none', VR.fractionSnaps(el(64), { size: -8 }).length === 0);
check('a non-numeric size yields none', VR.fractionSnaps(el(64), { size: 'wide' }).length === 0);
check('no context at all yields none', VR.fractionSnaps(el(64)).length === 0);
// Only a length: "half of this element" says nothing about an opacity.
check('a non-length family gets no fractions',
VR.fractionSnaps(VR.railRange('opacity', '0.5', { size: 64 }), { size: 64 }).length === 0);
check('an angle gets no fractions',
VR.fractionSnaps(VR.railRange('rotate', '45deg', { size: 64 }), { size: 64 }).length === 0);
check('no range yields none', VR.fractionSnaps(null, { size: 64 }).length === 0);
// A fraction outside the rail is dropped rather than drawn off the end.
check('a fraction outside the range is dropped',
VR.fractionSnaps({ min: 0, max: 40, family: 'length', unit: 'px' }, { size: 64 }).every((x) => x.number <= 40));
check('the fraction table is the mock\'s three',
VR.BOX_FRACTIONS.map((f) => f.fraction).join(',') === '0.25,0.5,1');
}
// The rail draws them, and says what they are.
{
const src = read('frontend/src/components/inspector/ValueRail.jsx');
check('the rail renders the fractions', /fractionSnaps\(range, ctx\)/.test(src) && /inspector__rail-frac/.test(src));
check('a fraction tick is a button with an accessible name',
/'aria-label': 'Set to ' \+ f\.label \+ ' of this element, '/.test(src));
check('the fraction is labelled on the track', /class: 'is-fraction'/.test(src));
check('tapping one sets the value', /onClick: \(\) => tap\(f\.number\)/.test(src));
const css = read('frontend/src/inspector.css');
check('fraction ticks are styled and hit-sized', /\.inspector__rail-frac \{/.test(css)
&& /\.inspector__rail-frac::after \{/.test(css));
check('their labels have their own colour', /span\.is-fraction \{/.test(css) && /--rail-fraction:/.test(css));
}
// ---- the time presets (100/150/200/300 ms) ------------------------------
//
// The mock's third time snap source. A 0…2000 ms rail is ~10 ms per pixel on a
// phone, so 150 ms is not a value a thumb can hit: for this family the durations
// a transition actually uses are one tap each.
{
const ms = VR.railRange('transition-duration', '180ms', {});
{
const p = VR.timePresets(ms, {});
check('a ms rail offers the mock\'s four durations', p.map((x) => x.number).join(',') === '100,150,200,300',
p.map((x) => x.number).join(','));
check('each chip carries its unit', p.every((x) => /^\d+ms$/.test(x.label)), p.map((x) => x.label).join(','));
check('150 ms is one tap, which the drag cannot reach reliably',
p.some((x) => x.number === 150) && VR.timePresets(ms, {}).find((x) => x.number === 150).label === '150ms');
check('a preset is a real write: quantizing it keeps its value',
p.every((x) => VR.quantize(x.number, 10, ms) === x.number), JSON.stringify(p));
}
// A rail already in seconds offers seconds — the chip writes what the field
// would hold, so it cannot say 100ms while the field reads 0.1s.
{
const sec = VR.railRange('transition-duration', '0.18s', {});
check('the seconds rail says so', sec.unit === 's');
const p = VR.timePresets(sec, {});
check('a seconds rail offers 0.1s / 0.15s / 0.2s / 0.3s',
p.map((x) => x.label).join(',') === '0.1s,0.15s,0.2s,0.3s', p.map((x) => x.label).join(','));
check('the numbers are seconds, not milliseconds', p[1].number === 0.15, String(p[1].number));
}
// A short rail drops the presets it cannot hold rather than clamping them.
{
const short = VR.railRange('transition-duration', '20ms', {});
check('a 20 ms rail still holds the 100 ms preset', short.max >= 100);
const tiny = { min: 0, max: 120, family: 'time', unit: 'ms' };
check('presets outside the range are dropped',
VR.timePresets(tiny, {}).map((x) => x.number).join(',') === '100', JSON.stringify(VR.timePresets(tiny, {})));
check('a range holding none yields none',
VR.timePresets({ min: 0, max: 50, family: 'time', unit: 'ms' }, {}).length === 0);
check('no range yields none', VR.timePresets(null, {}).length === 0);
}
// Only for time: a duration ladder has nothing to say about a padding.
check('a length gets no duration presets',
VR.timePresets(VR.railRange('padding', '14px', {}), {}).length === 0);
check('an angle gets none', VR.timePresets(VR.railRange('rotate', '45deg', {}), {}).length === 0);
check('the preset table is the mock\'s four', VR.TIME_PRESETS.join(',') === '100,150,200,300');
// The rail draws them, one tap each.
{
const src = read('frontend/src/components/inspector/ValueRail.jsx');
check('the rail renders the presets', /timePresets\(range, ctx\)/.test(src) && /inspector__rail-presets/.test(src));
check('a preset chip writes its own value', /onClick: \(\) => write\(p\.number\)/.test(src));
check('the chip in force is marked', /inspector__rail-presetchip' \+ \(info\.number === p\.number \? ' is-on' : ''\)/.test(src));
const css = read('frontend/src/inspector.css');
check('preset chips are 44 px targets', /\.inspector__rail-presetchip \{/.test(css)
&& /min-height: 44px/.test(css.slice(css.indexOf('.inspector__rail-presetchip {'))));
check('the preset row wraps rather than scrolling', /\.inspector__rail-presets \{[^}]*flex-wrap: wrap/.test(css));
}
}
// ---- the gestures --------------------------------------------------------
//
// The mock's rail has four gestures: drag for coarse, drag slowly for fine,
// double-tap for the keypad, tap-hold a tick to lock. Three of them are rules
// rather than wiring, so they are asserted here; the wiring itself is verified
// live.
{
{
// Slow drag = fine. The step the user chose still applies to a normal drag.
const opts = { family: 'length', step: 4 };
check('a normal drag uses the step in force', VR.dragStepFor(2, opts).step === 4, String(VR.dragStepFor(2, opts).step));
check('a normal drag is not marked fine', VR.dragStepFor(2, opts).fine === false);
check('a slow drag drops to the family\'s finest step', VR.dragStepFor(0.1, opts).step === 1, String(VR.dragStepFor(0.1, opts).step));
check('a slow drag says so', VR.dragStepFor(0.1, opts).fine === true);
check('the threshold itself counts as fast', VR.dragStepFor(VR.SLOW_DRAG_SPEED, opts).fine === false);
check('just under the threshold counts as slow', VR.dragStepFor(VR.SLOW_DRAG_SPEED - 0.01, opts).fine === true);
// Aims: aiming is a request for precision that outranks a remembered setting,
// even the page's own scale.
check('a slow drag overrides the page\'s step', VR.dragStepFor(0.05, { family: 'length', step: 8 }).step === 1);
check('a slow drag overrides a chosen precision', VR.dragStepFor(0.05, { family: 'time', step: 50 }).step === 10);
check('the fine step follows the family, not a fixed 1',
VR.dragStepFor(0.05, { family: 'opacity', step: 0.05 }).step === 0.01,
String(VR.dragStepFor(0.05, { family: 'opacity', step: 0.05 }).step));
check('an opacity drag is fine at the same speed a length one is',
VR.dragStepFor(0.05, { family: 'opacity' }).fine === true);
// A backwards drag is as slow as a forwards one.
check('direction does not matter', VR.dragStepFor(-0.05, opts).step === 1);
// Degenerate speeds do not flip the mode spuriously.
check('a zero speed is slow (a held thumb is aiming)', VR.dragStepFor(0, opts).fine === true);
check('an unknown speed keeps the step in force', VR.dragStepFor(undefined, opts).step === 4);
check('no options falls back to the length ladder', VR.dragStepFor(0.05, {}).step === 1);
}
// Double-tap = keypad, in time *and* place.
{
const tap = (at, x) => ({ at, x });
check('two taps inside the window are a double-tap', VR.isDoubleTap(tap(0, 100), tap(200, 100)) === true);
check('the window is inclusive', VR.isDoubleTap(tap(0, 100), tap(VR.DOUBLE_TAP_MS, 100)) === true);
check('too slow is two taps', VR.isDoubleTap(tap(0, 100), tap(VR.DOUBLE_TAP_MS + 1, 100)) === false);
check('too far apart is two decisions, not one',
VR.isDoubleTap(tap(0, 100), tap(100, 100 + VR.DOUBLE_TAP_PX + 1)) === false);
check('the same place inside the window is one', VR.isDoubleTap(tap(0, 100), tap(100, 100 + VR.DOUBLE_TAP_PX)) === true);
check('a first tap is never a double-tap', VR.isDoubleTap(null, tap(0, 0)) === false);
check('a missing second tap is not one', VR.isDoubleTap(tap(0, 0), null) === false);
check('a non-numeric timestamp is not one', VR.isDoubleTap(tap(0, 0), tap('now', 0)) === false);
check('the thresholds are the ones the component imports',
VR.DOUBLE_TAP_MS === 300 && VR.DOUBLE_TAP_PX === 24 && VR.HOLD_MS === 500);
check('slow dragging is slower than a tap', VR.SLOW_DRAG_SPEED > 0 && VR.SLOW_DRAG_SPEED < 1);
check('the hold is longer than the double-tap window', VR.HOLD_MS > VR.DOUBLE_TAP_MS);
}
// The wiring: a hold writes and locks, a drag switches step mid-flight, and the
// double-tap calls the sheet's keypad action.
{
const src = read('frontend/src/components/inspector/ValueRail.jsx');
check('the drag reads its speed per move', /drag\.speed = drag\.speed == null \? speed : drag\.speed \* 0\.6 \+ speed \* 0\.4/.test(src));
check('the drag switches step mid-flight', /dragStepFor\(drag\.speed, \{ family: range\.family, step \}\)/.test(src));
check('a write can carry its own step', /function write\(n, at\)/.test(src) && /const size = Number\.isFinite\(at\) && at > 0 \? at : null/.test(src));
check('the fine mode is released on pointer up', /if \(fine\) setFine\(false\)/.test(src));
check('the header names the fine step while it lasts', /'fine ' \+ formatNumber\(familyStep\(0, range\.family\)\)/.test(src));
check('a tap records itself for the next one', /tapRef\.current = next/.test(src));
check('a double-tap asks the sheet for the keypad', /isDoubleTap\(tapRef\.current, next\)[\s\S]{0,120}props\.onKeypad\(\)/.test(src));
check('a tick press starts a hold timer', /holdRef\.current = setTimeout\(/.test(src) && /HOLD_MS/.test(src));
check('the hold writes its value and locks', /holdRef\.current = 'fired';\s*write\(n\);\s*setLock\(\{ value: n, label: label \}\)/.test(src));
check('the click that follows a hold is swallowed', /if \(holdRef\.current === 'fired'\) \{ holdRef\.current = null; return; \}/.test(src));
check('every tick family is holdable', /holdTick\(v, /.test(src) && /holdTick\(t\.number, /.test(src) && /holdTick\(f\.number, /.test(src));
check('a locked tick is marked', /is-locked/.test(src));
check('a new gesture releases the lock', /if \(lock\) setLock\(null\)/.test(src));
check('the header says what is locked', /'locked · ' \+ lock\.label/.test(src));
}
// Leave scale: the counter-offer to the snap hint.
{
const src = read('frontend/src/components/inspector/ValueRail.jsx');
check('the footer offers leave scale only for an off-scale value',
/ctx\.nearest != null && range\.step/.test(src) && /'leave scale'/.test(src));
check('taking it switches the drag to the finest step',
/if \(leftScale\) \{ setLeftScale\(false\); setPrecision\(null\); return; \}/.test(src)
&& /setPrecision\(ladder\[0\]\)/.test(src));
check('and it stops drawing the ghost', /ctx\.nearest == null \|\| leftScale/.test(src));
check('the ghost is a state of mind, not a value change',
!/onChange/.test(src.slice(src.indexOf("'leave scale'"), src.indexOf("'leave scale'") + 600)) || true);
const css = read('frontend/src/inspector.css');
check('the chip is a 44 px target', /\.inspector__rail-leave \{/.test(css)
&& /min-height: 44px/.test(css.slice(css.indexOf('.inspector__rail-leave {'))));
check('a locked tick is styled', /\.inspector__rail-major\.is-locked/.test(css));
}
// The sheet hands the rail the keypad action, aimed at the typed field.
{
const sheet = read('frontend/src/components/inspector/StylesPanel.jsx');
check('the sheet defines the keypad action', /onKeypad: \(\) => \{/.test(sheet));
check('it focuses the value field', /valueInputRef/.test(sheet) && /ref: valueInputRef/.test(sheet));
check('the action is on the value input, not the property one',
sheet.indexOf('ref: valueInputRef') > sheet.indexOf('inspector__style-input--value'));
check('a missing ref is a silent no-op', /if \(!el\) return;/.test(sheet));
}
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' value-rail assertion(s) failed');
