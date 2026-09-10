// mouaif web — compact formatting for the file toolbar's +N / −N counts.
//
// The counts render at ~7px inside the folder glyph, so they have a hard
// width budget (see .file-toolbar__git-stats in chat-composer.css). Four-digit
// counts used to exceed the 1rem max-width and get cut off by `overflow:
// hidden` — "+1234" rendered as a truncated number. Abbreviating keeps every
// result at most four characters plus the sign:
//
//   formatCount(0)       -> '0'
//   formatCount(138)     -> '138'
//   formatCount(1000)    -> '1k'
//   formatCount(1250)    -> '1.3k'      (one decimal below 9.95k)
//   formatCount(9949)    -> '9.9k'
//   formatCount(12345)   -> '12k'       (whole thousands from 9.95k up)
//   formatCount(994999)  -> '995k'
//   formatCount(1200000) -> '1.2M'
//   formatCount(12300000)-> '12M'
//
// The unit thresholds overlap deliberately (9.95k flips to 10k, 995k flips to
// 1M) so rounding can never produce a five-character '1000k' or '10.0M'.
// Only the *display* is abbreviated — the button's aria-label still announces
// the exact counts, so screen readers lose nothing.

const UNITS = ['', 'k', 'M', 'G', 'T', 'P'];

function trimZero(text) {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

export function formatCount(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return String(Math.round(n));

  // Step up a unit whenever the mantissa would round to 1000 — the loop
  // re-tests after each division, so 999_500 becomes '1M' rather than
  // '1000k'. P (peta) is the last unit; beyond ~10^18 the mantissa would
  // reach 1000 and the result would overflow the width budget, but no line
  // count can get there.
  let unit = 0;
  let value = n;
  while (value >= 999.5 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  // One decimal below 9.95 so the mantissa stays at most three digits.
  const mantissa = unit > 0 && value < 9.95 ? trimZero(value.toFixed(1)) : String(Math.round(value));
  return mantissa + UNITS[unit];
}

// Longest result for any input below 10^18 is 4 characters ('995k', '9.9M'),
// so '+' + formatCount(n) always fits the folder's width budget.
export const MAX_FORMATTED_LENGTH = 4;
