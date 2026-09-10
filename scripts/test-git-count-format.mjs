// Verifies the file toolbar's compact count format.
//
// The +N / −N counts render at ~7px inside the folder glyph, where the width
// budget is about five characters including the sign. Anything longer is
// clipped by `overflow: hidden`, which is what used to happen to four-digit
// counts ("+1234" was silently truncated). These assertions pin two things:
// the abbreviation boundaries, and that no positive count can ever exceed four
// characters (so the box can never clip again).
import fs from 'node:fs';

// Same pattern as scripts/test-hidden-content-editor.mjs: load the frontend ESM
// helper through a data: URL so node does not warn about the CJS-typed package.
const source = (file) => fs.readFileSync(new URL('../frontend/src/' + file, import.meta.url), 'utf8');
const { formatCount, MAX_FORMATTED_LENGTH } = await import(
  'data:text/javascript;base64,' + Buffer.from(source('components/chat/gitCount.js')).toString('base64')
);

let failures = 0;
function check(input, expected) {
  const actual = formatCount(input);
  if (actual !== expected) {
    failures += 1;
    console.error('  FAIL  formatCount(' + input + ') = ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
  }
}

// Below 1000: the plain number.
check(0, '0');
check(1, '1');
check(138, '138');
check(999, '999');

// Four digits: one decimal below 9.95k, whole thousands from there up.
check(1000, '1k');
check(1049, '1k');
check(1250, '1.3k');
check(9949, '9.9k');

// The unit steps exist so rounding cannot emit a fifth character.
check(9950, '10k');
check(9999, '10k');
check(10000, '10k');
check(12345, '12k');
check(99999, '100k');
check(994999, '995k');
// 999_500 rounds up a full unit instead of becoming '1000k'.
check(999500, '1M');
check(995000, '995k');

// Millions and beyond.
check(1000000, '1M');
check(1200000, '1.2M');
check(9949999, '9.9M');
check(9950000, '10M');
check(12345678, '12M');
check(999999999, '1G');

// Non-finite / negative input is passed through as-is rather than mangled.
check(NaN, 'NaN');
check(-5, '-5');

// The invariant that matters for layout: no positive count formats to more
// than 4 characters, so "+" + formatCount(n) always fits the width budget.
const RANGE = [1, 5, 42, 999, 1000, 1001, 1099, 9999, 10000, 54321, 104999, 999999, 1000000, 7654321, 100000000, 999999999, 1234567890123];
for (const n of RANGE) {
  const len = String(formatCount(n)).length;
  if (len > MAX_FORMATTED_LENGTH) {
    failures += 1;
    console.error('  FAIL  formatCount(' + n + ') = ' + JSON.stringify(formatCount(n)) + ' is ' + len + ' chars, budget is ' + MAX_FORMATTED_LENGTH);
  }
}

// Exhaustive sweep of the boundaries, every value from 0 to 1.2M in steps of
// 7 — cheap, and it catches off-by-one rounding at the 9.95k / 995k steps.
for (let n = 0; n <= 1200000; n += 7) {
  const out = formatCount(n);
  // Escape the '.' in the alternation so ".0k"/".0M" are matched literally.
  if (out.length > 4 || /\.0[kM]$|^0\d|1000k|^10\.0M/.test(out)) {
    failures += 1;
    console.error('  FAIL  formatCount(' + n + ') = ' + JSON.stringify(out) + ' breaks a boundary rule');
    break;
  }
}

if (failures) {
  console.error('test-git-count-format: ' + failures + ' failure(s)');
  process.exit(1);
}
console.log('test-git-count-format: OK (boundaries + max width 4 chars)');
