// mouaif web — usage formatting helpers (browser side of src/usage.js).
//
// We don't ship the whole server module to the browser; the only
// browser-side need is to format the numbers the server already
// computed. The chat UI imports these and renders the cost /
// tok-per-second line under each user turn.
//
// Decision: docs/decisions.md §14. The server enriches the `done`
// SSE event with `{ cost: { known, input, output, total, currency },
// streamingMs, modelId }`; the chat UI never has to know about
// pricing resolution, and a chat that is re-opened later shows the
// same numbers that were on screen when the message was produced.

const DEFAULT_CURRENCY = 'USD';

function defaultLocale() {
  try {
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
    }
  } catch { /* swallow */ }
  return 'en-US';
}

// formatCost(amount) -> string
//
// Renders `--` when the amount is unknown (NaN / null), `$0.00` for
// zero, otherwise a USD-formatted number with 2–5 fractional
// digits. The decimal separator respects the user's locale; the
// currency symbol is always `$` (decision §14: USD only).
export function formatCost(amount) {
  const a = Number(amount);
  if (!isFinite(a) || a < 0) return '--';
  if (a === 0) return '$0.00';
  const digits = a < 0.01 ? 5 : a < 1 ? 5 : 2;
  const body = new Intl.NumberFormat(defaultLocale(), {
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: digits
  }).format(a);
  return '$' + body;
}

// formatTokPerSecond(rate) -> string
//
// Renders "37 tok/s" or "12.3 tok/s" depending on the magnitude.
// Renders `--` for unknown (NaN / negative).
export function formatTokPerSecond(rate) {
  const r = Number(rate);
  if (!isFinite(r) || r < 0) return '--';
  if (r === 0) return '0 tok/s';
  if (r >= 100) return Math.round(r) + ' tok/s';
  if (r >= 10)  return r.toFixed(1).replace(/\.0$/, '') + ' tok/s';
  return r.toFixed(2).replace(/\.?0+$/, '') + ' tok/s';
}

// formatTokens(n) -> string
//
// Compact display so 14 830 reads as "14.8K".
export function formatTokens(n) {
  const v = Number(n);
  if (!isFinite(v) || v < 0) return '--';
  if (v < 1000) return String(Math.round(v));
  if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + 'K';
  return (v / 1000000).toFixed(v < 10000000 ? 2 : 1) + 'M';
}

// createCounter() -> counter
//
// A per-turn streaming accumulator. The chat UI holds one of these
// for the active turn; the SSE `message` callback adds delta text,
// and `rate()` returns the current best-guess tokens-per-second.
//
// On `done`, the chat UI prefers the upstream's authoritative
// `completionTokens` (passed as `finalizeTokens`) over the heuristic
// sum so the final number is exact.
export function createCounter() {
  let startedAt = 0;
  let lastAt = 0;
  let estimatedTokens = 0;
  return {
    add(deltaText) {
      const now = Date.now();
      if (!startedAt) startedAt = now;
      lastAt = now;
      const len = typeof deltaText === 'string' ? deltaText.length : 0;
      if (len > 0) estimatedTokens += len / 4;
    },
    rate(finalizeTokens) {
      if (!startedAt) return 0;
      const ms = (lastAt || Date.now()) - startedAt;
      if (ms <= 0) return 0;
      const tokens = (typeof finalizeTokens === 'number' && isFinite(finalizeTokens))
        ? finalizeTokens
        : estimatedTokens;
      return (tokens / ms) * 1000;
    },
    reset() { startedAt = 0; lastAt = 0; estimatedTokens = 0; }
  };
}

export { DEFAULT_CURRENCY };
