// Tests for the inspector value display helpers (valueDisplay.js).
// Run: node scripts/test-inspector-value-display.js
import { splitValue, valueKind, shortenValue } from '../frontend/src/components/inspector/valueDisplay.js';

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + '\n    expected: ' + e + '\n    actual:   ' + a); }
}

console.log('splitValue');

// Empty input.
eq('empty string → no segments', splitValue(''), []);
eq('null → no segments', splitValue(null), []);

// Simple number + unit.
{
  const segs = splitValue('12px');
  eq('12px → number + unit', segs, [
    { text: '12', kind: 'number' },
    { text: 'px', kind: 'unit' }
  ]);
}

// Negative number.
{
  const segs = splitValue('-3.5rem');
  eq('-3.5rem → number + unit', segs, [
    { text: '-3.5', kind: 'number' },
    { text: 'rem', kind: 'unit' }
  ]);
}

// Percentage.
{
  const segs = splitValue('87.5%');
  eq('87.5% → number + unit', segs, [
    { text: '87.5', kind: 'number' },
    { text: '%', kind: 'unit' }
  ]);
}

// Hex colour.
{
  const segs = splitValue('#ffe600');
  eq('#ffe600 → color', segs, [{ text: '#ffe600', kind: 'color' }]);
}

// Function with args.
{
  const segs = splitValue('rgb(255, 230, 0)');
  const kinds = segs.map(s => s.kind);
  ok('rgb() has fn segment', kinds.includes('fn'));
  ok('rgb() has number segments', kinds.filter(k => k === 'number').length === 3);
  ok('rgb() has punct segments', kinds.includes('punct'));
  // Round-trip: segments join back to the original.
  eq('rgb() round-trips', segs.map(s => s.text).join(''), 'rgb(255, 230, 0)');
}

// Multi-value shorthand.
{
  const segs = splitValue('1px solid red');
  eq('shorthand round-trips', segs.map(s => s.text).join(''), '1px solid red');
  const kinds = segs.map(s => s.kind);
  ok('shorthand has number', kinds.includes('number'));
  ok('shorthand has unit', kinds.includes('unit'));
  ok('shorthand has color (red)', kinds.includes('color'));
  ok('shorthand has space segments', kinds.includes('space'));
}

// calc() expression.
{
  const segs = splitValue('calc(100% - 20px)');
  eq('calc() round-trips', segs.map(s => s.text).join(''), 'calc(100% - 20px)');
  ok('calc() has fn segment', segs.some(s => s.kind === 'fn' && s.text === 'calc'));
}

// Keyword.
{
  const segs = splitValue('auto');
  eq('auto → text', segs, [{ text: 'auto', kind: 'text' }]);
}

// Named colour.
{
  const segs = splitValue('transparent');
  eq('transparent → color', segs, [{ text: 'transparent', kind: 'color' }]);
}

// var() reference.
{
  const segs = splitValue('var(--space-card)');
  eq('var() round-trips', segs.map(s => s.text).join(''), 'var(--space-card)');
  ok('var() has fn segment', segs.some(s => s.kind === 'fn'));
}

// Round-trip property: for a variety of values, segments always join back.
{
  const samples = [
    '12px', '1.5rem', '100%', '0', '-5px', 'auto', 'none', 'inherit',
    '#fff', '#ff0000', '#ff000080', 'rgb(1, 2, 3)', 'rgba(1, 2, 3, 0.5)',
    'hsl(120, 50%, 50%)', 'red', 'blue', 'transparent', 'currentcolor',
    '1px solid black', '10px 20px', '10px 20px 30px 40px',
    'cubic-bezier(0.4, 0, 0.2, 1)', 'calc(100% - 2px)',
    'url(image.png)', 'linear-gradient(red, blue)',
    'var(--token)', 'translateX(10px) rotate(45deg)',
    '0 1px 2px rgba(0,0,0,0.4)', 'inset 0 0 10px #000',
    'normal normal 400 16px/1.5 sans-serif'
  ];
  let allRoundTrip = true;
  for (const s of samples) {
    const joined = splitValue(s).map(seg => seg.text).join('');
    if (joined !== s) {
      allRoundTrip = false;
      console.error('    round-trip failed for: ' + JSON.stringify(s) + ' → ' + JSON.stringify(joined));
    }
  }
  ok('all samples round-trip', allRoundTrip);
}

console.log('valueKind');

eq('hex → color', valueKind('color', '#fff'), 'color');
eq('rgb() → color', valueKind('color', 'rgb(1,2,3)'), 'color');
eq('named → color', valueKind('color', 'red'), 'color');
eq('transparent → color', valueKind('color', 'transparent'), 'color');
eq('12px → length', valueKind('width', '12px'), 'length');
eq('1.5rem → length', valueKind('margin', '1.5rem'), 'length');
eq('100% → length', valueKind('width', '100%'), 'length');
eq('0.5 → number', valueKind('opacity', '0.5'), 'number');
eq('12 → number', valueKind('z-index', '12'), 'number');
eq('auto → keyword', valueKind('width', 'auto'), 'keyword');
eq('flex → keyword', valueKind('display', 'flex'), 'keyword');
eq('expression → other', valueKind('width', 'calc(100% - 2px)'), 'other');
eq('empty → other', valueKind('color', ''), 'other');

console.log('shortenValue');

// Short value: returned as-is.
eq('short value unchanged', shortenValue('12px', 40), '12px');
eq('exact length unchanged', shortenValue('1234567890', 10), '1234567890');

// Long value: trimmed with ellipsis.
{
  const short = shortenValue('cubic-bezier(0.4, 0, 0.2, 1)', 20);
  ok('long value is shortened', short.length <= 21);
  ok('shortened ends with ellipsis', short.endsWith('…'));
  ok('shortened does not cut mid-function', !short.match(/\($/) && !short.match(/,$/));
}

// Very long font-family.
{
  const long = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const short = shortenValue(long, 30);
  ok('long font shortened', short.length <= 31);
  ok('long font ends with ellipsis', short.endsWith('…'));
}

// Never cuts a number from its unit.
{
  const short = shortenValue('123456789px', 8);
  // Either "123456789px" fits or we get a whole token + ellipsis.
  ok('number+unit not split', short.endsWith('…') && !/\d$/.test(short.slice(0, -1)) || short === '123456789px');
}

// Minimum length respected.
eq('min length 8', shortenValue('abcdefghijklmnopqrstuvwxyz', 5).length <= 9, true);

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
