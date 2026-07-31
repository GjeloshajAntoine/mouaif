'use strict';

// Usage metrics — cost and live token speed for chat turns.
//
// Decision: docs/decisions.md §14. The AI client (src/ai.js) already
// emits `usage_input`, `usage_output`, and `done({ usage })` events on
// every chat. This module is a pure derivation layer: it consumes those
// numbers, the model record, and the resolved app-level pricing table
// and produces:
//
//   - cost: { input, output, total, currency, known }
//   - per-turn rate: tokens per second over the streaming window
//   - formatted strings ready to drop into the chat UI
//
// No new SSE events, no new REST surface, no new runtime dependencies.
// The chat UI (src/web/src/components/Chat.jsx) imports formatCost /
// formatTokPerSecond; the Settings UI lets the user edit the
// app-level pricing table through the existing /api/settings/app
// surface.

// ---- Built-in pricing table -------------------------------------------
//
// Best-effort defaults for model ids that the providers ship today.
// Adding a new model id is a one-line edit. The cost line falls back
// to `--` when the id is unknown; we deliberately do not hallucinate
// a price. The values are in USD per 1 000 tokens (input / output).
//
// Sourced from each provider's public pricing page at the time of
// this commit. They are best-effort and a future revision may add
// a "last verified" stamp.
const BUILTIN_PRICING = Object.freeze({
  // OpenAI (https://openai.com/api/pricing/, as of mid-2026)
  'gpt-4o':                  { inputPer1K: 0.00250, outputPer1K: 0.01000 },
  'gpt-4o-mini':             { inputPer1K: 0.00015, outputPer1K: 0.00060 },
  'gpt-4.1':                 { inputPer1K: 0.00200, outputPer1K: 0.00800 },
  'gpt-4.1-mini':            { inputPer1K: 0.00040, outputPer1K: 0.00160 },
  'gpt-4.1-nano':            { inputPer1K: 0.00010, outputPer1K: 0.00040 },
  'o3':                      { inputPer1K: 0.01000, outputPer1K: 0.04000 },
  'o3-mini':                 { inputPer1K: 0.00110, outputPer1K: 0.00440 },
  'o4-mini':                 { inputPer1K: 0.00110, outputPer1K: 0.00440 },
  'gpt-5':                   { inputPer1K: 0.00125, outputPer1K: 0.01000 },
  'gpt-5-mini':              { inputPer1K: 0.00025, outputPer1K: 0.00200 },
  'gpt-5-nano':              { inputPer1K: 0.00005, outputPer1K: 0.00040 },
  // Anthropic (https://www.anthropic.com/pricing)
  'claude-3-5-sonnet-latest':{ inputPer1K: 0.00300, outputPer1K: 0.01500 },
  'claude-3-5-haiku-latest': { inputPer1K: 0.00080, outputPer1K: 0.00400 },
  'claude-3-opus-latest':    { inputPer1K: 0.01500, outputPer1K: 0.07500 },
  'claude-sonnet-4':         { inputPer1K: 0.00300, outputPer1K: 0.01500 },
  'claude-sonnet-4-5':       { inputPer1K: 0.00300, outputPer1K: 0.01500 },
  'claude-sonnet-4.5':       { inputPer1K: 0.00300, outputPer1K: 0.01500 },
  'claude-haiku-4-5':        { inputPer1K: 0.00080, outputPer1K: 0.00400 },
  'claude-haiku-4.5':        { inputPer1K: 0.00080, outputPer1K: 0.00400 },
  'claude-opus-4':           { inputPer1K: 0.01500, outputPer1K: 0.07500 },
  'claude-opus-4-1':         { inputPer1K: 0.01500, outputPer1K: 0.07500 },
  'claude-opus-4.1':         { inputPer1K: 0.01500, outputPer1K: 0.07500 },
  // Google Gemini (https://ai.google.dev/pricing)
  'gemini-2.5-pro':          { inputPer1K: 0.00125, outputPer1K: 0.01000 },
  'gemini-2.5-flash':        { inputPer1K: 0.00030, outputPer1K: 0.00250 },
  'gemini-2.0-flash':        { inputPer1K: 0.00010, outputPer1K: 0.00040 },
  'gemini-1.5-pro':          { inputPer1K: 0.00125, outputPer1K: 0.00500 },
  'gemini-1.5-flash':        { inputPer1K: 0.000075, outputPer1K: 0.00030 }
});

const DEFAULT_CURRENCY = 'USD';

// ---- Pricing resolution ----------------------------------------------

// resolvePricing(model, app) -> { inputPer1K, outputPer1K, source } | null
// Walks the resolution order documented in §14:
//   1. model.pricing             (per-project, most specific)
//   2. app.modelPricing[modelId] (app-level override)
//   3. BUILTIN_PRICING[modelId]  (best-effort defaults)
//   4. null                      (the UI renders `--`)
//
// `model` may be the project model record, the resolved model (with
// provider hydrated in), or just `{ id }` — only `id` and `pricing`
// are read.
// `app` is the app-level settings object (settings.getApp()).
function resolvePricing(model, app) {
  if (!model || typeof model !== 'object' || !model.id) return null;
  const id = model.id;
  const fromModel = pickPricing(model.pricing);
  if (fromModel) return Object.assign({ source: 'model' }, fromModel);
  const appPricing = app && app.modelPricing;
  if (appPricing && typeof appPricing === 'object') {
    const fromApp = pickPricing(appPricing[id]);
    if (fromApp) return Object.assign({ source: 'app' }, fromApp);
  }
  const fromBuiltIn = builtinPricingForId(id);
  if (fromBuiltIn) return Object.assign({ source: 'builtin' }, fromBuiltIn);
  return null;
}

function builtinPricingForId(id) {
  if (!id) return null;
  if (BUILTIN_PRICING[id]) return BUILTIN_PRICING[id];
  // OpenRouter model ids are vendor-prefixed (e.g. openai/gpt-5-mini,
  // anthropic/claude-sonnet-4.5). Reuse the built-in vendor price when
  // the suffix exactly matches a known native model id.
  const slash = String(id).lastIndexOf('/');
  if (slash >= 0) {
    const suffix = String(id).slice(slash + 1);
    if (BUILTIN_PRICING[suffix]) return BUILTIN_PRICING[suffix];
  }
  return null;
}

function pickPricing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = numberOrNull(raw.inputPer1K);
  const output = numberOrNull(raw.outputPer1K);
  if (input == null && output == null) return null;
  const out = { inputPer1K: input || 0, outputPer1K: output || 0 };
  // Optional per-model prompt-cache pricing factors. When present they
  // override the standard 10% / 125% tiers for this model (see computeCost);
  // when absent the defaults apply. Carried through the resolution chain
  // so an app-level or model-level override can tune a single model.
  const read = factorOrNull(raw.cacheReadFactor);
  const write = factorOrNull(raw.cacheWriteFactor);
  if (read != null) out.cacheReadFactor = read;
  if (write != null) out.cacheWriteFactor = write;
  return out;
}

function numberOrNull(v) {
  if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) && Number(v) >= 0) {
    return Number(v);
  }
  return null;
}

// factorOrNull(v) — same acceptance as numberOrNull but returns null for
// 0 / missing so pickPricing only carries factors the user actually set.
function factorOrNull(v) {
  if (v == null || v === '') return null;
  const n = numberOrNull(v);
  return n == null || n === 0 ? null : n;
}

// ---- Cost calculation -------------------------------------------------

// Anthropic prompt-cache pricing factors (docs: https://docs.claude.com/en/docs/build-with-claude/prompt-caching#pricing).
// Cache reads are billed at 10% of the base input rate; cache writes
// (creating/refreshing a cache entry) at 125% of the base input rate.
// These are the DEFAULTS and are uniform across Claude models today, but
// a pricing record can override them per model (see resolvePricing:
// `pricing.cacheReadFactor` / `pricing.cacheWriteFactor`) because the
// provider has changed these rates before and could again, or a future
// model could ship its own tiers.
const DEFAULT_CACHE_READ_FACTOR = 0.10;
const DEFAULT_CACHE_WRITE_FACTOR = 1.25;

// computeCost({ model, usage, app }) -> { input, output, total, currency, known }
//
// `usage` is `{ promptTokens, completionTokens, cacheReadTokens?,
// cacheCreationTokens? }` — the shape on the `done` event from the AI
// client (decision §10), with the two Anthropic cache fields optional.
// Missing keys are treated as 0. `model` and `app` are passed straight
// through to resolvePricing. Returns a `known: false` object when no
// pricing is found so the UI can render `--` cleanly.
//
// Cost is computed at the provider's tiered rates: cached reads at
// 10% of input, cache writes at 125% of input, and everything else
// (uncached prompt + completions) at the base rates. The factors come
// from the resolved pricing record (per-model overrides) with the
// defaults above. The `input` bucket keeps the base uncached prompt cost
// so a `usage` block with no cache fields prices identically to before
// this feature.
function computeCost({ model, usage, app } = {}) {
  const u = usage || {};
  const promptTokens = num(u.promptTokens);
  const completionTokens = num(u.completionTokens);
  const cacheReadTokens = num(u.cacheReadTokens);
  const cacheCreationTokens = num(u.cacheCreationTokens);
  const pricing = resolvePricing(model, app);
  if (!pricing) {
    return {
      input: 0,
      output: 0,
      total: 0,
      currency: DEFAULT_CURRENCY,
      known: false
    };
  }
  const cacheReadFactor = factorOrDefault(pricing.cacheReadFactor, DEFAULT_CACHE_READ_FACTOR);
  const cacheWriteFactor = factorOrDefault(pricing.cacheWriteFactor, DEFAULT_CACHE_WRITE_FACTOR);
  // Cached reads/writes are a subset of the reported prompt tokens, so
  // the uncached input portion is what remains after subtracting them
  // (never below zero — a provider reporting odd numbers must not
  // produce negative cost).
  const cachedTokens = cacheReadTokens + cacheCreationTokens;
  const uncachedInput = Math.max(0, promptTokens - cachedTokens);
  const input = (uncachedInput / 1000) * pricing.inputPer1K
    + (cacheReadTokens / 1000) * pricing.inputPer1K * cacheReadFactor
    + (cacheCreationTokens / 1000) * pricing.inputPer1K * cacheWriteFactor;
  const output = (completionTokens / 1000) * pricing.outputPer1K;
  const total = input + output;
  return {
    input,
    output,
    total,
    currency: DEFAULT_CURRENCY,
    known: true
  };
}

// factorOrDefault(v, fallback) -> number
// A pricing factor must be a finite number >= 0 to be honored; anything
// else (absent, null, a bad value in a user-edited .mouaif.json) falls
// back to the standard factor.
function factorOrDefault(v, fallback) {
  if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) && Number(v) >= 0) return Number(v);
  return fallback;
}

function num(v) {
  const n = Number(v);
  return isFinite(n) && n >= 0 ? n : 0;
}

// ---- Formatting -------------------------------------------------------

// formatCost(amount, { locale } = {}) -> string
//
// Format a USD amount with 2–5 fractional digits. Values below
// 0.000005 round to `$0.00000`; $0 renders as `$0.00` so the row is
// never empty. The decimal separator respects the user's locale; the
// currency symbol is always `$` because pricing is USD-only (per §14).
//
// We don't use `Intl.NumberFormat`'s `style: 'currency'` because
// some locales (e.g. en-US) emit `US$` for that formatter, which
// would break the iOS-style list aesthetic. The decimal separator
// is still locale-aware via `Intl.NumberFormat({ useGrouping })`
// without the currency style, then we prepend a literal `$`.
function formatCost(amount, opts) {
  const a = Number(amount);
  if (!isFinite(a) || a < 0) return '--';
  if (a === 0) return '$0.00';
  const locale = (opts && opts.locale) || defaultLocale();
  const digits = a < 0.01 ? 5 : a < 1 ? 5 : 2;
  // toLocaleString picks the locale's decimal separator. We use
  // maximumFractionDigits: 5 to match the spec ("2–5 significant
  // figures") while still letting `0.00012` read as `0.00012`
  // instead of `0.0001`.
  const body = new Intl.NumberFormat(locale, {
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: digits
  }).format(a);
  return '$' + body;
}

// formatTokPerSecond(rate) -> string
//
// Returns "37 tok/s" or "12.3 tok/s" depending on the magnitude.
// Renders `--` when the rate is unknown (NaN / negative / null).
function formatTokPerSecond(rate) {
  const r = Number(rate);
  if (!isFinite(r) || r < 0) return '--';
  if (r === 0) return '0 tok/s';
  if (r >= 100) return Math.round(r) + ' tok/s';
  if (r >= 10)  return r.toFixed(1).replace(/\.0$/, '') + ' tok/s';
  return r.toFixed(2).replace(/\.?0+$/, '') + ' tok/s';
}

// formatTokens(n) -> string  (e.g. 243 -> "243", 14830 -> "14.8K")
//
// Used by the per-turn meta line so large numbers don't push the row
// past 360 px. Matches the project's existing chat style.
function formatTokens(n) {
  const v = Number(n);
  if (!isFinite(v) || v < 0) return '--';
  if (v < 1000) return String(Math.round(v));
  if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + 'K';
  return (v / 1000000).toFixed(v < 10000000 ? 2 : 1) + 'M';
}

function defaultLocale() {
  try {
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
    }
  } catch { /* swallow */ }
  return 'en-US';
}

// ---- Live token-speed counter ----------------------------------------

// A tiny accumulator for the per-turn streaming window. The chat UI
// holds one of these per active turn; the SSE callbacks poke samples
// in as deltas arrive.
//
//   const counter = createCounter();
//   on('message', (delta) => counter.add(estimateDeltaTokens(delta)));
//   on('done',   () => finalizeTurn(counter));
//
// We don't ask the upstream for per-delta token counts (no provider
// emits them) so the per-delta estimate is character-based: every 4
// characters of text is ~1 token. This is intentionally rough — the
// spec calls the counter "informational", and the final rate uses
// the upstream's authoritative `completionTokens` from `done`.
//
// finalizeTokens: the real completion token count from the upstream
// (or null if the stream ended before the upstream reported usage).
// When provided, the rate is `completionTokens / streamingMs`; when
// absent, we fall back to the sum of delta estimates.
function createCounter() {
  let startedAt = 0;
  let lastAt = 0;
  let estimatedTokens = 0;
  return {
    add(deltaText) {
      const now = Date.now();
      if (!startedAt) startedAt = now;
      lastAt = now;
      // Rough heuristic: ~4 chars per token. We could weight this by
      // word boundaries, but the counter is purely client-side
      // ("informational", per decision §14) and the final value is
      // overridden by the upstream's `done` payload anyway.
      const len = typeof deltaText === 'string' ? deltaText.length : 0;
      if (len > 0) estimatedTokens += len / 4;
    },
    // Returns the current best-guess rate. `finalizeTokens` is the
    // upstream-reported completion token count; when it is null the
    // heuristic sum is used instead.
    rate(finalizeTokens) {
      if (!startedAt) return 0;
      const ms = (lastAt || Date.now()) - startedAt;
      if (ms <= 0) return 0;
      const tokens = (typeof finalizeTokens === 'number' && isFinite(finalizeTokens))
        ? finalizeTokens
        : estimatedTokens;
      return (tokens / ms) * 1000;
    },
    // Resets the counter for a new turn. Called after `done` is
    // received (or after the chat is re-entered) so the next user
    // message starts from 0.
    reset() { startedAt = 0; lastAt = 0; estimatedTokens = 0; }
  };
}

module.exports = {
  BUILTIN_PRICING,
  builtinPricingForId,
  resolvePricing,
  computeCost,
  formatCost,
  formatTokPerSecond,
  formatTokens,
  createCounter
};
