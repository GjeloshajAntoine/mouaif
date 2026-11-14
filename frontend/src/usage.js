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
// zero, otherwise a USD-formatted number with 2–5 fractional digits.
// Values below 0.000005 round to `$0.00000`. The decimal separator
// respects the user's locale; the currency symbol is always `$`
// (decision §14: USD only).
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

// A rate over a shorter window is noise, not a speed: a reply that
// arrives in one or two chunks would divide its tokens by a few
// milliseconds. Below this the tok/s item is left off the line.
export const MIN_RATE_WINDOW_MS = 250;

// tokensPerSecond(tokens, ms) -> number | null
//
// null when there is no meaningful rate (unknown tokens, or a window
// shorter than MIN_RATE_WINDOW_MS).
export function tokensPerSecond(tokens, ms) {
  const t = Number(tokens);
  const w = Number(ms);
  if (!isFinite(t) || t < 0 || !isFinite(w) || w < MIN_RATE_WINDOW_MS) return null;
  return (t / w) * 1000;
}

// usageRate(usage, streamingMs) -> number | null
//
// The tok/s of a saved row: its round's output tokens over its round's
// window. `hiddenReasoningTokens` (reasoning the provider counted but
// never streamed, so generated before the window opened) are left out.
export function usageRate(usage, streamingMs) {
  if (!usage || typeof usage.completionTokens !== 'number') return null;
  const hidden = Number(usage.hiddenReasoningTokens) > 0 ? Number(usage.hiddenReasoningTokens) : 0;
  return tokensPerSecond(Math.max(0, usage.completionTokens - hidden), streamingMs);
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
    // touch() extends the window to now without adding text: output the
    // model produced since the last text delta (tool-call arguments) took
    // time too, and the round's reported token count includes it.
    touch() { if (startedAt) lastAt = Date.now(); },
    // rate(finalizeTokens) -> tok/s, or null until the window is long
    // enough to mean something (see MIN_RATE_WINDOW_MS).
    rate(finalizeTokens) {
      if (!startedAt) return null;
      const tokens = (typeof finalizeTokens === 'number' && isFinite(finalizeTokens))
        ? finalizeTokens
        : estimatedTokens;
      return tokensPerSecond(tokens, (lastAt || Date.now()) - startedAt);
    },
    reset() { startedAt = 0; lastAt = 0; estimatedTokens = 0; }
  };
}

export { DEFAULT_CURRENCY };
