'use strict';

// Account balance lookup for the providers that expose one.
//
// The chat head shows a "Balance" pill next to "Context" and "Total" when the
// connection's provider can report how much credit the account has left.
// OpenRouter answers that with one key-scoped endpoint; DeepSeek answers its
// own `GET {origin}/user/balance` (handled by balanceFromDeepSeek); Codex is
// the one *subscription* connection, with no money balance at all — it reports
// the ChatGPT plan's rate-limit windows instead (handled by
// balanceFromCodexUsage); and OpenAI-compatible reaches the routes the OpenAI
// *dashboard* asks itself:
//
//   GET {origin}/dashboard/billing/credit_grants   (prepaid accounts)
//   GET {origin}/dashboard/billing/subscription    (usage-capped accounts)
//   GET {origin}/dashboard/billing/usage           (cents already spent)
//
// The first answer is preferred because it is already a remaining amount. When
// a connection has no grants (a pay-as-you-go account), the remaining credit is
// derived as `hard_limit_usd - total_usage / 100` — usage is reported in cents,
// the limit in dollars. Anything that does not answer with a usable number is
// reported as unsupported rather than guessed at: the pill is informational, and
// a wrong number is worse than no pill.
//
// The OpenAI billing routes are sent to the connection's *origin*
// (`https://api.openai.com`), not to its `/v1` API root, because that is where
// the dashboard lives. A local OpenAI-shaped server (llama.cpp `llama-server`,
// LM Studio) answers neither route; it is also the one case where a connection
// legitimately has no credential, and this module is only reached with one.

const { joinUrl } = require('./util.js');

// The providers that serve the OpenAI *dashboard* billing routes. Only
// openai-compatible reaches them: /dashboard/billing/{credit_grants,
// subscription,usage} lives on api.openai.com, and the other vendors 404 it
// (measured: api.mistral.ai and api.groq.com answer 404 for the billing path
// *and* for a bogus path, i.e. a catch-all — the route does not exist). They
// were listed here, so every chat-open fired requests that could only ever
// 404 and then reported "no balance": the pill never appeared, while the docs
// claimed it would.
//
// Each other vendor has its own route, handled below:
//   deepseek  GET {origin}/user/balance
//   mistral   GET {origin}/v1/admin/spend-limit   (Admin API key only)
//   codex     GET {origin}/backend-api/wham/usage (ChatGPT plan windows)
//
// Groq publishes no balance API at all, so no pill is the honest answer for it.
const OPENAI_BILLING_PROVIDERS = Object.freeze([
  'openai-compatible'
]);

// DeepSeek documents GET {origin}/user/balance.
const DEEPSEEK_BALANCE_PATH = '/user/balance';

// Mistral's Admin API. https://docs.mistral.ai/admin/admin-api/usage-metrics
//
//   GET {origin}/v1/admin/spend-limit  ->  { limits: { completion: {...},
//                                              currency }, ... }
//
// It is deliberately *not* folded into the OpenAI routes above: Mistral's
// auth is the `x-api-key` header (not `Authorization: Bearer`), the path is
// /v1/admin/..., and — unlike the OpenAI dashboard routes — it needs an
// Admin-scoped key ("Standard workspace/inference API keys are rejected",
// per the OpenAPI security scheme). A workspace key therefore gets a 401 and
// the pill stays hidden, which is correct: the balance is genuinely not
// readable with the credential the user stored.
const MISTRAL_SPEND_LIMIT_PATH = '/v1/admin/spend-limit';

// Codex (ChatGPT plan) has no money balance — it is the one subscription
// connection. What it does have is the account's rate-limit windows, which the
// backend that serves the Codex CLI answers at `GET {origin}/backend-api/wham/usage`
// (measured: 401 without a bearer token, while a bogus sibling path answers 403,
// so the route exists). The payload carries the plan type and a primary
// (session, 5 h) plus a secondary (weekly) window, each with `used_percent`.
//
// The pill is defined as "the number of dollars the account has left", and this
// provider has no such number. Reporting the *used* percentage in that slot
// would be a lie in the same shape as the other providers' figures, so the
// label says what the value really is ("Plan 62%") and no dollar sign is
// involved. The two windows are not summed or picked apart: the shorter one is
// the one that actually stops work, so it is the one reported.
const CODEX_USAGE_PATH = '/backend-api/wham/usage';

// supportsBalance(provider) -> does this connection have a balance route we
// know how to read? Four families: the OpenAI dashboard routes, DeepSeek's
// /user/balance, Mistral's Admin API spend limit, and Codex's plan windows.
function supportsBalance(provider) {
  if (provider === 'deepseek' || provider === 'mistral' || provider === 'codex') return true;
  return OPENAI_BILLING_PROVIDERS.indexOf(provider) !== -1;
}

// originOf(baseUrl) -> string
//
// The scheme + host + port of a connection's base URL, with no trailing slash
// and no path. Falls back to the raw string when it does not parse, so a
// hand-written base URL still produces a request instead of a TypeError.
function originOf(baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''));
    return u.origin;
  } catch {
    return String(baseUrl || '').replace(/\/+$/, '');
  }
}

// numberOrNull(v) — a finite, non-negative number, else null. Accepts the
// string forms providers sometimes return for money fields.
function numberOrNull(v) {
  if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (isFinite(n) && n >= 0) return n;
  }
  return null;
}

// ---- response shapes ----------------------------------------------------

// balanceFromGrants(body) -> { remaining, totalCredits, totalUsage } | null
//
// Prepaid accounts: the route answers `{ total_granted, total_used,
// total_available }` (the `grants` object repeats the same numbers as strings
// and is used as a fallback). `total_available` is already the remaining
// amount; the two totals are the fallback and are also what other surfaces
// (the usage page) want to show.
function balanceFromGrants(body) {
  if (!body || typeof body !== 'object') return null;
  const grants = body.grants && typeof body.grants === 'object' ? body.grants : {};
  const totalCredits = numberOrNull(body.total_granted) ?? numberOrNull(grants.total_granted);
  const totalUsage = numberOrNull(body.total_used) ?? numberOrNull(grants.total_used);
  let remaining = numberOrNull(body.total_available) ?? numberOrNull(grants.total_available);
  if (remaining == null && totalCredits != null && totalUsage != null) {
    remaining = totalCredits - totalUsage;
  }
  if (remaining == null) return null;
  return {
    remaining,
    totalCredits: totalCredits == null ? undefined : totalCredits,
    totalUsage: totalUsage == null ? undefined : totalUsage
  };
}

// balanceFromSubscription(subscription, usage) -> { remaining, totalCredits,
// totalUsage } | null
//
// Usage-capped accounts have no grant balance: the hard limit is the ceiling
// and the usage route reports what has been spent *in cents*, so both sides are
// normalized to dollars before subtracting.
function balanceFromSubscription(subscription, usage) {
  if (!subscription || typeof subscription !== 'object') return null;
  const hardLimit = numberOrNull(subscription.hard_limit_usd)
    ?? numberOrNull(subscription.system_hard_limit_usd)
    ?? numberOrNull(subscription.soft_limit_usd);
  if (hardLimit == null) return null;
  const cents = numberOrNull(usage && usage.total_usage);
  const totalUsage = cents == null ? 0 : cents / 100;
  return {
    remaining: Math.max(0, hardLimit - totalUsage),
    totalCredits: hardLimit,
    totalUsage
  };
}

// ---- the lookup ---------------------------------------------------------

// balanceFromDeepSeek(body) -> { remaining, totalCredits?, totalUsage? } | null
//
// DeepSeek reports `{ is_available, balance_infos: [{ currency,
// total_balance, granted_balance, topped_up_balance }] }`. `total_balance` is
// already the remaining amount. Amounts arrive as strings, hence numberOrNull.
// The account can hold several currencies; the USD row is preferred when one is
// present, otherwise the first row — the pill has room for a single figure and
// labelling the wrong currency would be worse than picking the primary one.
function balanceFromDeepSeek(body) {
  if (!body || typeof body !== 'object') return null;
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos.filter((i) => i && typeof i === 'object') : [];
  if (!infos.length) return null;
  const primary = infos.find((i) => String(i.currency || '').toUpperCase() === 'USD') || infos[0];
  const remaining = numberOrNull(primary.total_balance);
  if (remaining == null) return null;
  const out = { remaining };
  const granted = numberOrNull(primary.granted_balance);
  const topped = numberOrNull(primary.topped_up_balance);
  if (granted != null || topped != null) out.totalCredits = (granted || 0) + (topped || 0);
  if (typeof body.is_available === 'boolean' && body.is_available === false) out.remaining = 0;
  return out;
}

// balanceFromMistral(body) -> { remaining, totalCredits?, totalUsage? } | null
//
// The Admin API answers { limits: { completion: UsageLimits, currency, ... } },
// where UsageLimits carries `total_usage` (spent) and `usage_limit` (the cap),
// both as whole numbers in the Organization's billing currency — not cents
// (Mistral's own docs, on the POST that writes the same field: "`500` means
// 500, not 500 cents"). So the remaining balance is `usage_limit -
// total_usage`, with no unit conversion.
//
// `no_monthly_limit: true` means the account is uncapped: there is no ceiling
// to subtract from, so this returns null and no pill is shown. Guessing a
// number there would be worse than showing none — the same rule the rest of
// this module follows. `total_usage` absent is likewise "unknown", not zero.
function balanceFromMistral(body) {
  if (!body || typeof body !== 'object') return null;
  const limits = body.limits && typeof body.limits === 'object' ? body.limits : null;
  if (!limits) return null;
  const completion = limits.completion && typeof limits.completion === 'object' ? limits.completion : limits;
  if (completion.no_monthly_limit === true) return null;
  const limit = numberOrNull(completion.usage_limit);
  const used = numberOrNull(completion.total_usage) ?? numberOrNull(completion.usage);
  if (limit == null || used == null) return null;
  return {
    remaining: Math.max(0, limit - used),
    totalCredits: limit,
    totalUsage: used
  };
}

// codexWindowPercent(entry) -> number | null
//
// One rate-limit window as a used percentage. The window is reported as an
// object (`used_percent`); a bare number is accepted too, because the shape is
// only known from measurement and a number is the other plausible spelling.
// Anything above 100 is clamped rather than shown as-is.
function codexWindowPercent(entry) {
  const raw = entry && typeof entry === 'object' ? (entry.used_percent ?? entry.usedPercent) : entry;
  const pct = numberOrNull(raw);
  if (pct == null) return null;
  return Math.min(100, pct);
}

// balanceFromCodexUsage(body) -> { label, value } | null
//
// Codex answers with the plan and its rate-limit windows, e.g.
// `{ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 62 }, … } }`
// — the primary window is the 5-hour session and the secondary is the weekly
// one. The pill shows the *primary* window's used percentage, because that is
// the limit the user actually hits first; the weekly window is not summed in
// and does not substitute for it, since "62% of the session" and "62% of the
// week" are different facts and the pill has room for one.
//
// The plan type is folded into the label so the value reads as what it is
// ("Plan plus 62%") instead of as a dollar balance. A payload with no window at
// all returns null — no number is guessed, exactly as for every other provider.
function balanceFromCodexUsage(body) {
  if (!body || typeof body !== 'object') return null;
  const root = body.rate_limit && typeof body.rate_limit === 'object' ? body.rate_limit : body;
  const used = codexWindowPercent(root.primary_window ?? root.primary);
  if (used == null) return null;
  const plan = typeof body.plan_type === 'string' ? body.plan_type.trim() : '';
  return { label: plan ? 'Plan ' + plan : 'Plan', value: Math.round(used) + '%' };
}

// lookupBalance({ provider, baseUrl, cred, fetchImpl }) ->
//   { ok: true, label, remaining, totalCredits?, totalUsage? }
// | { ok: true, label, value }
// | { ok: false, code, status?, error }
//
// Two successful shapes: a *money* answer (`remaining`, in the billing
// currency, plus the totals the usage surfaces want) and a *percentage* answer
// (`value`, already formatted — the ChatGPT plan windows). The request handler
// passes either through to the UI.
//
// Never throws: a `fetchImpl` that rejects comes back as EUNREACHABLE, so the
// request handler has one error shape to translate. A non-2xx answer on *both*
// billing routes is EUPSTREAM with the status of the first one, which is what
// the UI would want to show if it ever surfaced the failure.
async function lookupBalance({ provider, baseUrl, cred, fetchImpl } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const origin = originOf(baseUrl);
  const headers = { Authorization: 'Bearer ' + cred, Accept: 'application/json' };

  // Mistral's Admin API lives under /v1/admin and requires an Admin-scoped
  // key. Its two auth headers disagree across Mistral's own sources:
  //
  //   * the prose guide (docs.mistral.ai/admin/admin-api/authentication) says
  //     "pass your Admin API key in the `x-api-key` header", and every curl
  //     sample there sends `x-api-key`;
  //   * the OpenAPI security scheme instead declares AdminApiKey as
  //     `type: http / scheme: bearer` ("passed as a bearer token"), and the
  //     reference generated from that spec renders every sample as
  //     `Authorization: Bearer …` with no `x-api-key` anywhere.
  //
  // Both cannot be right, and the live gateway returns an identical
  // `401 {"detail":"Invalid API Key"}` for either header (and for none), so it
  // cannot settle the question without a real Admin key. Sending BOTH is safe
  // because they are independent headers, and it is the pattern already used
  // for OpenRouter's `X-OpenRouter-Title` / `X-Title` pair in
  // src/ai-endpoints.js: whichever name the deployment reads, it finds one.
  // This costs nothing and is the only choice that cannot be wrong-by-omission
  // for a user whose key would otherwise silently produce no pill.
  //
  // A workspace-scoped key is rejected outright by this route, so it still
  // reports "no balance" rather than an error the user cannot act on.
  if (provider === 'mistral') {
    let res;
    try {
      const r = await doFetch(joinUrl(origin, MISTRAL_SPEND_LIMIT_PATH), {
        headers: { 'x-api-key': cred, ...headers }
      });
      res = r && r.ok
        ? { status: r.status, ok: true, body: await r.json().catch(() => null) }
        : { status: r ? r.status : 0, ok: false, body: null };
    } catch {
      return { ok: false, code: 'EUNREACHABLE', error: 'provider unreachable' };
    }
    if (res.ok) {
      const fromMistral = balanceFromMistral(res.body);
      if (fromMistral) return Object.assign({ ok: true, label: 'Balance' }, fromMistral);
    }
    return {
      ok: false,
      code: 'EUPSTREAM',
      status: res.status || 0,
      error: provider + ' returned no usable balance'
    };
  }

  // softGet(path) -> { status, ok, body } | null (null = transport failure)
  const softGet = async (path) => {
    try {
      const r = await doFetch(joinUrl(origin, path), { headers });
      if (!r || !r.ok) return { status: r ? r.status : 0, ok: false, body: null };
      const body = await r.json().catch(() => null);
      return { status: r.status, ok: true, body };
    } catch {
      return null;
    }
  };

  // DeepSeek has its own balance route, not the OpenAI dashboard ones. Asking
  // api.deepseek.com for /dashboard/billing/* could only ever 404.
  if (provider === 'deepseek') {
    const res = await softGet(DEEPSEEK_BALANCE_PATH);
    if (res == null) {
      return { ok: false, code: 'EUNREACHABLE', error: 'provider unreachable' };
    }
    if (res.ok) {
      const fromDeepSeek = balanceFromDeepSeek(res.body);
      if (fromDeepSeek) return Object.assign({ ok: true, label: 'Balance' }, fromDeepSeek);
    }
    return {
      ok: false,
      code: 'EUPSTREAM',
      status: res.status || 0,
      error: provider + ' returned no usable balance'
    };
  }

  // Codex is a subscription, not a credit: ask the ChatGPT backend for the
  // plan's rate-limit windows. Its base URL is already the backend root
  // (`https://chatgpt.com/backend-api/codex`), while the usage route hangs off
  // `/backend-api` — hence originOf above, and the same reasoning that sends
  // the OpenAI billing routes to the origin rather than the API root.
  if (provider === 'codex') {
    const res = await softGet(CODEX_USAGE_PATH);
    if (res == null) {
      return { ok: false, code: 'EUNREACHABLE', error: 'provider unreachable' };
    }
    if (res.ok) {
      const fromCodex = balanceFromCodexUsage(res.body);
      if (fromCodex) return Object.assign({ ok: true }, fromCodex);
    }
    return {
      ok: false,
      code: 'EUPSTREAM',
      status: res.status || 0,
      error: provider + ' returned no usable balance'
    };
  }

  const grantsRes = await softGet('/dashboard/billing/credit_grants');
  if (grantsRes == null) {
    return { ok: false, code: 'EUNREACHABLE', error: 'provider unreachable' };
  }
  if (grantsRes.ok) {
    const fromGrants = balanceFromGrants(grantsRes.body);
    if (fromGrants) return Object.assign({ ok: true, label: 'Balance' }, fromGrants);
  }

  const subRes = await softGet('/dashboard/billing/subscription');
  if (subRes == null) {
    return { ok: false, code: 'EUNREACHABLE', error: 'provider unreachable' };
  }
  if (subRes.ok) {
    const usageRes = await softGet('/dashboard/billing/usage');
    if (usageRes == null) {
      return { ok: false, code: 'EUNREACHABLE', error: 'provider unreachable' };
    }
    const fromSub = balanceFromSubscription(subRes.body, usageRes.ok ? usageRes.body : null);
    if (fromSub) return Object.assign({ ok: true, label: 'Balance' }, fromSub);
  }

  // No route answered with a number. A self-hosted or gateway endpoint is the
  // expected case here, and it reads as `supported: false` on purpose: the
  // connection works, it just has no account balance to show.
  return {
    ok: false,
    code: 'EUPSTREAM',
    status: grantsRes.status || subRes.status || 0,
    error: provider + ' returned no usable balance'
  };
}

module.exports = {
  OPENAI_BILLING_PROVIDERS,
  DEEPSEEK_BALANCE_PATH,
  MISTRAL_SPEND_LIMIT_PATH,
  CODEX_USAGE_PATH,
  supportsBalance,
  originOf,
  balanceFromGrants,
  balanceFromSubscription,
  balanceFromDeepSeek,
  balanceFromMistral,
  balanceFromCodexUsage,
  lookupBalance
};
