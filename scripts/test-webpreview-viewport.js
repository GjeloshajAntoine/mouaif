'use strict';
// Unit test for the webpreview viewport normalisation (src/tools/webpreview.js).
// Verifies that preset ids, WIDTHxHEIGHT strings, custom size arguments, and
// malformed inputs all resolve to the capture rectangle the tool expects.

const { resolveViewport, VIEWPORTS, DEFAULT_VIEWPORT_ID } = require('../src/tools/webpreview.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

// Default when nothing is supplied
const d = resolveViewport(undefined);
check('no arg -> default id', d.id === DEFAULT_VIEWPORT_ID, 'got ' + d.id);
check('no arg -> default dims', d.width === VIEWPORTS[DEFAULT_VIEWPORT_ID].width && d.height === VIEWPORTS[DEFAULT_VIEWPORT_ID].height);

// Known preset ids (case-insensitive)
for (const id of ['phone', 'phone+', 'tablet', 'laptop']) {
  const vp = resolveViewport(id);
  check('preset id ' + id + ' resolves', vp.id === id && vp.width === VIEWPORTS[id].width && vp.height === VIEWPORTS[id].height, JSON.stringify(vp));
}
const upper = resolveViewport('PHONE');
check('preset id is case-insensitive', upper.id === 'phone', 'got ' + upper.id);

// Phone presets are mobile; tablet/laptop are not
check('phone is mobile', resolveViewport('phone').mobile === true);
check('laptop is desktop', resolveViewport('laptop').mobile === false);

// WIDTHxHEIGHT strings (both separators, case-insensitive)
const c1 = resolveViewport('1280x800');
check('custom 1280x800', c1.width === 1280 && c1.height === 800 && c1.id === 'custom' && c1.mobile === false, JSON.stringify(c1));
const c2 = resolveViewport('390×844');
check('custom uses unicode ×', c2.width === 390 && c2.height === 844 && c2.id === 'custom', JSON.stringify(c2));
const c3 = resolveViewport(' 1024 x 768 ');
check('custom trims whitespace', c3.width === 1024 && c3.height === 768, JSON.stringify(c3));

// Malformed / unknown values fall back to the default
check('unknown id -> default', resolveViewport('wat').id === DEFAULT_VIEWPORT_ID, 'got ' + resolveViewport('wat').id);
check('blank string -> default', resolveViewport('  ').id === DEFAULT_VIEWPORT_ID, 'got ' + resolveViewport('  ').id);
check('garbage -> default', resolveViewport('12x').id === DEFAULT_VIEWPORT_ID, 'got ' + resolveViewport('12x').id);
check('negative -> default', resolveViewport('-5x-5').id === DEFAULT_VIEWPORT_ID, 'got ' + resolveViewport('-5x-5').id);

// Runaway dimensions are clamped into a sane range
const big = resolveViewport('5000x5000');
check('custom clamp (max)', big.width === 2048 && big.height === 2048, JSON.stringify(big));
const tiny = resolveViewport('10x10');
check('custom clamp (min)', tiny.width === 64 && tiny.height === 64, JSON.stringify(tiny));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
