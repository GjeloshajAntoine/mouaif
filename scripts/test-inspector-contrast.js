'use strict';
// Inspector colour contrast — WCAG luminance and the ratio badge.
//
// The edit sheet shows a contrast ratio on every colour candidate so a
// legibility mistake is visible before Apply. That number has to be the WCAG
// one, so this suite pins the luminosity maths against published pairs and the
// AA/AAA thresholds, then checks the parsing and compositing that feed it.
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
return typeof a === 'number' && Math.abs(a - b) <= (tol == null ? 0.01 : tol);
}
const ctx = vm.createContext({});
vm.runInContext(strip(read('frontend/src/components/inspector/valueKinds.js')), ctx);
vm.runInContext(strip(read('frontend/src/components/inspector/contrast.js'))
+ '\n;globalThis.CO = { AA_MIN, AAA_MIN, parseColor, relativeLuminance, composite, contrastRatio, contrastLevel, contrastBadge, contrast, readableOn, suggestTextColor, hslToRgb, rgbToHsl };\n', ctx);
const CO = ctx.CO;
check('the module loads', !!CO && typeof CO.contrast === 'function');
check('AA and AAA minimums are the WCAG ones', CO.AA_MIN === 4.5 && CO.AAA_MIN === 7);
// ---- relative luminance -------------------------------------------------
check('black has zero luminance', CO.relativeLuminance({ r: 0, g: 0, b: 0 }) === 0);
check('white has full luminance', near(CO.relativeLuminance({ r: 255, g: 255, b: 255 }), 1, 1e-9));
check('mid grey is the published 0.2158605',
near(CO.relativeLuminance({ r: 128, g: 128, b: 128 }), 0.2158605, 1e-6),
String(CO.relativeLuminance({ r: 128, g: 128, b: 128 })));
check('red, green and blue carry their WCAG weights',
near(CO.relativeLuminance({ r: 255, g: 0, b: 0 }), 0.2126, 1e-9)
&& near(CO.relativeLuminance({ r: 0, g: 255, b: 0 }), 0.7152, 1e-9)
&& near(CO.relativeLuminance({ r: 0, g: 0, b: 255 }), 0.0722, 1e-9));
// ---- the known pairs ----------------------------------------------------
check('black on white is 21:1', near(CO.contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21, 1e-9));
check('white on white is 1:1', near(CO.contrastRatio({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }), 1, 1e-9));
check('the ratio is order-independent',
near(CO.contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }),
CO.contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }), 1e-9));
{
// The documented example: #777 on #fff ≈ 4.48:1 — a hair under AA, which is
// exactly the kind of near-miss the badge exists to reveal. The level is
// decided by the true ratio (4.478), so the badge prints two decimals rather
// than rounding the near-miss up to a passing `4.5`.
const r = CO.contrast('#ffffff', '#777777');
check('#777 on #fff parses and measures', r.ok === true, JSON.stringify(r));
check('#777 on #fff is ≈ 4.48:1', near(r.ratio, 4.48, 0.01), String(r.ratio));
check('#777 on #fff is reported just under AA', r.level === 'fail', String(r.level));
check('#777 on #fff prints the near-miss at two decimals', r.text === 'fail 4.48:1', r.text);
}
check('#767676 on #fff is the AA boundary and passes',
CO.contrast('#ffffff', '#767676').level === 'AA',
JSON.stringify(CO.contrast('#ffffff', '#767676')));
check('#595959 on #fff clears AAA',
CO.contrast('#ffffff', '#595959').level === 'AAA',
JSON.stringify(CO.contrast('#ffffff', '#595959')));
// The mock's palette pair, computed rather than copied: the mock's `AA 5.1:1`
// badge is an illustration, and the real WCAG ratio for this pair is 8.7:1.
check('the mock pair #9cc2ff on #1c2333 is AAA 8.7:1',
CO.contrast('#1c2333', '#9cc2ff').text === 'AAA 8.7:1',
JSON.stringify(CO.contrast('#1c2333', '#9cc2ff')));
check('the mock pair #2b3a56 on #1c2333 fails',
CO.contrast('#1c2333', '#2b3a56').level === 'fail',
JSON.stringify(CO.contrast('#1c2333', '#2b3a56')));
check('white on the mock page background clears AAA',
CO.contrast('#131824', '#ffffff').level === 'AAA',
JSON.stringify(CO.contrast('#131824', '#ffffff')));
// ---- the thresholds -----------------------------------------------------
check('4.49 is below AA', CO.contrastLevel(4.49).level === 'fail');
check('4.5 is AA', CO.contrastLevel(4.5).level === 'AA');
check('6.99 is AA', CO.contrastLevel(6.99).level === 'AA');
check('7 is AAA', CO.contrastLevel(7).level === 'AAA');
check('21 is AAA', CO.contrastLevel(21).level === 'AAA');
check('zero is a fail', CO.contrastLevel(0).level === 'fail');
check('a non-number is a fail, not a crash', CO.contrastLevel(undefined).level === 'fail');
// ---- the badge label ----------------------------------------------------
check('an AAA ratio reads AAA 12.6:1', CO.contrastBadge(12.63).text === 'AAA 12.6:1', CO.contrastBadge(12.63).text);
check('the badge shortens to one decimal inside a band',
CO.contrastBadge(5.14).text === 'AA 5.1:1', CO.contrastBadge(5.14).text);
check('a near-miss keeps two decimals so the level is not misread',
CO.contrastBadge(4.48).text === 'fail 4.48:1', CO.contrastBadge(4.48).text);
check('an AA badge is marked ok', CO.contrastBadge(5.1).ok === true && CO.contrastBadge(5.1).text === 'AA 5.1:1', CO.contrastBadge(5.1).text);
check('a fail badge is not ok', CO.contrastBadge(1.8).ok === false && CO.contrastBadge(1.8).text === 'fail 1.8:1', CO.contrastBadge(1.8).text);
check('a missing ratio says so instead of printing NaN', CO.contrastBadge(null).text === 'no ratio');
// ---- colour parsing -----------------------------------------------------
check('a 6-digit hex parses', JSON.stringify(CO.parseColor('#1c2333')) === JSON.stringify({ r: 28, g: 35, b: 51, a: 1 }));
check('a 3-digit hex expands', CO.parseColor('#abc').r === 170 && CO.parseColor('#abc').b === 204);
check('an 8-digit hex keeps its alpha', near(CO.parseColor('#00000080').a, 0.502, 0.01));
check('rgb() parses', CO.parseColor('rgb(28, 35, 51)').g === 35);
check('rgba() parses its alpha', near(CO.parseColor('rgba(0,0,0,0.5)').a, 0.5, 1e-9));
check('the modern space syntax parses', CO.parseColor('rgb(28 35 51)').b === 51);
check('the modern slash alpha parses', near(CO.parseColor('rgb(28 35 51 / 40%)').a, 0.4, 1e-9));
check('percentage channels parse', CO.parseColor('rgb(50%, 50%, 50%)').r === 128, JSON.stringify(CO.parseColor('rgb(50%, 50%, 50%)')));
check('hsl() parses to rgb', CO.parseColor('hsl(220, 38%, 15%)').b > CO.parseColor('hsl(220, 38%, 15%)').r);
check('a named colour parses', JSON.stringify(CO.parseColor('white')) === JSON.stringify({ r: 255, g: 255, b: 255, a: 1 }));
check('transparent parses as zero alpha', CO.parseColor('transparent').a === 0);
check('currentcolor resolves through the context',
CO.parseColor('currentcolor', { color: '#123456' }).b === 0x56);
check('currentcolor without a context is unreadable', CO.parseColor('currentcolor') === null);
check('a gradient is not a colour', CO.parseColor('linear-gradient(red, blue)') === null);
check('a variable is not a colour', CO.parseColor('var(--brand)') === null);
check('an unknown name is not a colour', CO.parseColor('rebeccapurple-typo') === null);
check('an empty string is not a colour', CO.parseColor('') === null);
// ---- compositing --------------------------------------------------------
{
const solid = CO.composite({ r: 255, g: 255, b: 255, a: 1 }, { r: 0, g: 0, b: 0 });
check('an opaque foreground composites to itself', solid.r === 255 && solid.b === 255);
const half = CO.composite({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 });
check('a half-transparent white on black is mid grey', half.r === 128, JSON.stringify(half));
const none = CO.composite({ r: 255, g: 255, b: 255, a: 0 }, { r: 20, g: 30, b: 40 });
check('a fully transparent colour shows the backdrop',
none.r === 20 && none.g === 30 && none.b === 40);
// A translucent text colour is decided by the composition, not by its own
// channels: rgba(255,255,255,.08) on a dark card is nearly the card.
const card = CO.contrast('#131824', 'rgba(255,255,255,0.08)');
check('a translucent foreground is composited before measuring', card.ok === true);
check('a near-invisible foreground reads as a fail', card.level === 'fail', JSON.stringify(card));
}
// ---- contrast() honesty -------------------------------------------------
check('an unreadable colour is reported, not guessed',
CO.contrast('#fff', 'var(--x)').ok === false && !!CO.contrast('#fff', 'var(--x)').reason);
check('a transparent background has no ratio',
CO.contrast('transparent', '#fff').ok === false
&& /transparent/.test(CO.contrast('transparent', '#fff').reason));
check('the resolved `color` is the default foreground',
CO.contrast('#ffffff', null, { color: '#000000' }).ratio === 21);
check('the resolved `background-color` is the default background',
CO.contrast(null, '#ffffff', { bg: '#000000' }).ratio === 21);
check('currentcolor works through the context',
CO.contrast('#ffffff', 'currentcolor', { color: '#000000' }).ratio === 21);
// ---- candidates ---------------------------------------------------------
{
const candidates = CO.readableOn('#131824', [
{ value: '#ffffff' }, { value: '#9cc2ff' }, { value: '#2b3a56' }, { value: 'var(--x)' }
]);
check('every candidate keeps its value', candidates.length === 4);
check('a readable candidate carries its badge text', candidates[0].text === 'AAA 17.7:1', candidates[0].text);
check('a marginal candidate is marked unreadable', candidates[2].readable === false);
check('an unparseable candidate still renders, with its reason',
candidates[3].ratio === null && !!candidates[3].reason, JSON.stringify(candidates[3]));
check('a bare string candidate is accepted', CO.readableOn('#fff', ['#000'])[0].ratio === 21);
check('no candidates is an empty list', CO.readableOn('#fff', null).length === 0);
}
// ---- the default pair ---------------------------------------------------
{
const onDark = CO.suggestTextColor('#131824');
check('the default suggestion on a dark card is white text',
onDark[0].value === '#ffffff' && onDark[0].readable === true, JSON.stringify(onDark));
const onLight = CO.suggestTextColor('#ffffff');
check('the default suggestion on a light card is black text',
onLight[0].value === '#000000' && onLight[0].readable === true, JSON.stringify(onLight));
check('an unreadable background suggests nothing', CO.suggestTextColor('var(--x)').length === 0);
}
// ---- hsl round trip -----------------------------------------------------
{
// The mock's K2 hue rail is 220°, and its card resolves to #1c2333 — hsl(222,
// 29%, 15%) — so the rail's read position comes back from the pixel values
// rather than from the string that was typed.
const rgb = CO.hslToRgb(222, 0.29, 0.155);
check('hsl -> rgb produces the mock card colour',
rgb.r === 28 && rgb.g === 35 && rgb.b === 51, JSON.stringify(rgb));
const back = CO.rgbToHsl({ r: 28, g: 35, b: 51 });
check('rgb -> hsl round-trips the hue', near(back.h, 222, 1), String(back.h));
check('rgb -> hsl round-trips saturation and lightness',
near(back.s, 0.29, 0.02) && near(back.l, 0.155, 0.02), JSON.stringify(back));
check('a grey has no hue', CO.rgbToHsl({ r: 128, g: 128, b: 128 }).h === 0);
check('hslToRgb wraps a negative hue',
JSON.stringify(CO.hslToRgb(-138, 0.29, 0.155)) === JSON.stringify(CO.hslToRgb(222, 0.29, 0.155)));
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' contrast assertion(s) failed');
