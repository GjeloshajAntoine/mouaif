'use strict';

// Tests for src/providerCredit.js — the OpenAI-shaped account balance lookup
// behind GET /api/ai/provider-credit.
//
// The module has two jobs worth pinning down:
//   1. read the OpenAI billing routes in the documented order (credit grants,
//      then subscription limit minus usage) and normalize both to dollars;
//   2. never invent a number. A provider that answers without a balance (a
//      self-hosted llama.cpp server, a key without billing scope) must come
//      back as a failure for the caller to translate into "no pill", and a
//      transport failure must be distinguishable from that.
//
// The HTTP surface is covered separately by scripts/test-provider-credit-route.js.

const path = require('path');

const credit = require(path.resolve(__dirname, '..', 'src', 'providerCredit.js'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  -- ' + detail : '')); }
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// fakeFetch(routes) -> { fetch, calls }
// `routes` maps a pathname to a response factory; a missing route answers 404.
function fakeFetch(routes, opts = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (opts.throwOn && opts.throwOn.test(url)) throw new Error('connect ECONNREFUSED');
    const pathname = new URL(url).pathname;
    const route = routes[pathname];
    if (!route) return jsonResponse({ error: { message: 'not found' } }, 404);
    return typeof route === 'function' ? route() : route;
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  // ---- which providers are supported -----------------------------------
  // Each family has its own route: the OpenAI dashboard billing routes (which
  // live on api.openai.com), DeepSeek's /user/balance, and Mistral's Admin API
  // spend limit. Listing a provider that has none meant a pill that could
  // never appear.
  check('openai-compatible reaches the OpenAI billing routes',
    credit.supportsBalance('openai-compatible'));
  check('deepseek has its own balance route', credit.supportsBalance('deepseek'));
  check('mistral has an Admin API spend-limit route', credit.supportsBalance('mistral'));
  check('codex reports its ChatGPT plan window instead of a balance',
    credit.supportsBalance('codex'));
  check('groq is NOT routed through any balance lookup', !credit.supportsBalance('groq'));
  check('openrouter is NOT routed through the OpenAI billing shape',
    !credit.supportsBalance('openrouter'));
  check('anthropic/gemini have no balance route',
    !credit.supportsBalance('anthropic') && !credit.supportsBalance('gemini'));

  // ---- origin handling -------------------------------------------------
  check('originOf strips /v1 from the API base',
    credit.originOf('https://api.openai.com/v1') === 'https://api.openai.com',
    credit.originOf('https://api.openai.com/v1'));
  check('originOf keeps an explicit port',
    credit.originOf('http://127.0.0.1:11434/v1') === 'http://127.0.0.1:11434');
  check('originOf survives a hand-written base URL',
    credit.originOf('not-a-url') === 'not-a-url');

  // ---- credit grants ---------------------------------------------------
  {
    const f = fakeFetch({
      '/dashboard/billing/credit_grants': jsonResponse({
        object: 'credit_summary', total_granted: 20, total_used: 16.58, total_available: 3.42
      })
    });
    const r = await credit.lookupBalance({
      provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', cred: 'sk-demo', fetchImpl: f
    });
    check('grants: reports the remaining amount', r.ok && r.remaining === 3.42, JSON.stringify(r));
    check('grants: carries the totals through', r.ok && r.totalCredits === 20 && r.totalUsage === 16.58);
    check('grants: labelled Balance', r.ok && r.label === 'Balance');
    check('grants: asks the origin, not /v1',
      f.calls[0].url === 'https://api.openai.com/dashboard/billing/credit_grants', f.calls[0].url);
    check('grants: sends the bearer token',
      f.calls[0].init.headers.Authorization === 'Bearer sk-demo');
    check('grants: stops after the first answer (no subscription call)', f.calls.length === 1);
  }

  // ---- grants reported as strings, in the nested object ----------------
  {
    const f = fakeFetch({
      '/dashboard/billing/credit_grants': jsonResponse({
        total_granted: '20.00', total_used: '16.58', total_available: '3.42',
        grants: { object: 'list', data: [] }
      })
    });
    const r = await credit.lookupBalance({
      provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', cred: 'k', fetchImpl: f
    });
    check('grants: string amounts are accepted', r.ok && r.remaining === 3.42, JSON.stringify(r));
  }

  // ---- grants with no total_available: derive it -----------------------
  {
    const f = fakeFetch({
      '/dashboard/billing/credit_grants': jsonResponse({ total_granted: 10, total_used: 4 })
    });
    const r = await credit.lookupBalance({
      provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', cred: 'k', fetchImpl: f
    });
    check('grants: remaining is derived when only the totals are present',
      r.ok && r.remaining === 6, JSON.stringify(r));
  }

  // ---- usage-capped accounts: hard limit minus usage (in cents) --------
  {
    const f = fakeFetch({
      '/dashboard/billing/subscription': jsonResponse({ hard_limit_usd: 20, soft_limit_usd: 18 }),
      '/dashboard/billing/usage': jsonResponse({ total_usage: 1658 })  // cents
    });
    const r = await credit.lookupBalance({
      provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', cred: 'k', fetchImpl: f
    });
    check('subscription: usage cents convert to dollars (20 - 16.58)',
      r.ok && Math.abs(r.remaining - 3.42) < 1e-9, JSON.stringify(r));
    check('subscription: hard limit is the credit total', r.ok && r.totalCredits === 20);
    check('subscription: usage is in dollars', r.ok && Math.abs(r.totalUsage - 16.58) < 1e-9);
    check('subscription: grants were tried first (3 calls total)', f.calls.length === 3,
      f.calls.map((c) => c.url).join(', '));
  }

  // ---- a spent-out account floors at zero, never negative --------------
  {
    const f = fakeFetch({
      '/dashboard/billing/subscription': jsonResponse({ hard_limit_usd: 5 }),
      '/dashboard/billing/usage': jsonResponse({ total_usage: 900 })
    });
    const r = await credit.lookupBalance({
      provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', cred: 'k', fetchImpl: f
    });
    check('subscription: over-spend floors at 0', r.ok && r.remaining === 0, JSON.stringify(r));
  }

  // ---- a local server answers nothing usable ---------------------------
  {
    const f = fakeFetch({});
    const r = await credit.lookupBalance({
      provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', cred: 'k', fetchImpl: f
    });
    check('no billing route: reported as unsupported, not a number',
      r.ok === false && r.code === 'EUPSTREAM', JSON.stringify(r));
    check('no billing route: still asked the local origin',
      f.calls[0].url === 'http://127.0.0.1:11434/dashboard/billing/credit_grants', f.calls[0].url);
  }

  // ---- a gateway that answers HTML / garbage ---------------------------
  {
    const f = async (url) => ({
      ok: true, status: 200, json: async () => { throw new Error('Unexpected token <'); }
    });
    const r = await credit.lookupBalance({
      provider: 'openai-compatible', baseUrl: 'https://gateway.example/v1', cred: 'k', fetchImpl: f
    });
    check('unparseable body: unsupported, never a guessed number',
      r.ok === false && r.code === 'EUPSTREAM', JSON.stringify(r));
  }

  // ---- transport failure is its own code -------------------------------
  {
    const f = fakeFetch({}, { throwOn: /credit_grants/ });
    const r = await credit.lookupBalance({
      provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', cred: 'k', fetchImpl: f
    });
    check('a refused connection is EUNREACHABLE', r.ok === false && r.code === 'EUNREACHABLE',
      JSON.stringify(r));
  }

  // ---- a missing usage answer prices the ceiling as untouched ----------
  {
    const f = fakeFetch({
      '/dashboard/billing/subscription': jsonResponse({ hard_limit_usd: 12 })
    });
    const r = await credit.lookupBalance({
      provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', cred: 'k', fetchImpl: f
    });
    check('subscription without a usage answer reports the full limit',
      r.ok && r.remaining === 12 && r.totalUsage === 0, JSON.stringify(r));
  }

  // ---- DeepSeek uses its own /user/balance route ------------------------
  //
  // It does NOT serve the OpenAI dashboard routes, so asking it for
  // /dashboard/billing/* could only ever fail. These cases pin both the route
  // and the response shape ({ balance_infos: [{ currency, total_balance }] },
  // amounts as strings).
  {
    const calls = [];
    const f = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/user/balance')) {
        return jsonResponse({
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '12.50', granted_balance: '0.00', topped_up_balance: '12.50' }]
        });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const r = await credit.lookupBalance({
      provider: 'deepseek', baseUrl: 'https://api.deepseek.com', cred: 'k', fetchImpl: f
    });
    check('deepseek: asks /user/balance, not the OpenAI billing routes',
      calls.length === 1 && calls[0] === 'https://api.deepseek.com/user/balance',
      calls.join(', '));
    check('deepseek: parses total_balance into remaining',
      r.ok && r.remaining === 12.5, JSON.stringify(r));

    // USD is preferred when the account holds several currencies.
    const multi = await credit.balanceFromDeepSeek({
      balance_infos: [
        { currency: 'CNY', total_balance: '71.00' },
        { currency: 'USD', total_balance: '10.00' }
      ]
    });
    check('deepseek: prefers the USD row when several currencies exist',
      multi && multi.remaining === 10, JSON.stringify(multi));

    // is_available: false is the provider saying the balance cannot be spent.
    const spent = await credit.balanceFromDeepSeek({
      is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }]
    });
    check('deepseek: is_available false floors the balance at 0',
      spent && spent.remaining === 0, JSON.stringify(spent));

    // No balance_infos at all is "unsupported", never a guessed 0.
    check('deepseek: a body without balance_infos is not a number',
      (await credit.balanceFromDeepSeek({ is_available: true })) === null);
  }

  // ---- Mistral reads its Admin API spend limit --------------------------
  //
  // The Admin API answers { limits: { completion: { total_usage, usage_limit },
  // currency } }, with the key sent under both documented header names (the
  // prose guide says x-api-key, the OpenAPI scheme says bearer). Amounts are
  // whole numbers in the billing currency, NOT cents (Mistral's docs, on the
  // POST that writes the same field: "500 means 500, not 500 cents").
  {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/v1/admin/spend-limit')) {
        return jsonResponse({
          limits: {
            completion: { no_monthly_limit: false, monthly_limit_reached: false, usage: 12.5, total_usage: 12.5, usage_limit: 500 },
            currency: 'USD'
          }
        });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const r = await credit.lookupBalance({
      provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1', cred: 'admin-key', fetchImpl: f
    });
    check('mistral: asks /v1/admin/spend-limit',
      calls.length === 1 && calls[0].url === 'https://api.mistral.ai/v1/admin/spend-limit',
      calls.map((c) => c.url).join(', '));
    check('mistral: sends the key under BOTH header names',
      calls[0].init && calls[0].init.headers
      && calls[0].init.headers['x-api-key'] === 'admin-key'
      && calls[0].init.headers.Authorization === 'Bearer admin-key',
      JSON.stringify(calls[0].init && calls[0].init.headers));
    check('mistral: limit minus usage, with no cents conversion (500 - 12.5)',
      r.ok && r.remaining === 487.5 && r.totalCredits === 500 && r.totalUsage === 12.5,
      JSON.stringify(r));

    // Uncapped account: no ceiling to subtract from, so no pill and no guess.
    check('mistral: no_monthly_limit is not a number',
      (await credit.balanceFromMistral({ limits: { completion: { no_monthly_limit: true, total_usage: 12.5 } } })) === null);

    // A missing usage figure is "unknown", never a zero-spend assumption.
    check('mistral: a limit with no reported usage is not a number',
      (await credit.balanceFromMistral({ limits: { completion: { usage_limit: 500 } } })) === null);

    // Over-spend floors at 0 rather than reporting a negative balance.
    const over = await credit.balanceFromMistral({ limits: { completion: { total_usage: 600, usage_limit: 500 } } });
    check('mistral: over-spend floors at 0', over && over.remaining === 0, JSON.stringify(over));

    // A body shaped like the OpenAI grants payload is not Mistral's shape.
    check('mistral: an OpenAI-shaped body is not read as a balance',
      (await credit.balanceFromMistral({ total_available: 7.5 })) === null);
  }

  // ---- Codex reports plan windows, not a money balance ------------------
  //
  // Codex is the one subscription connection: there are no dollars to report,
  // so the pill carries the ChatGPT plan's rate-limit *used* percentage and no
  // currency symbol. The route is the backend's /backend-api/wham/usage, which
  // hangs off the origin (the connection's base URL is already
  // /backend-api/codex).
  {
    const f = fakeFetch({
      '/backend-api/wham/usage': jsonResponse({
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 61.5, window_minutes: 300 },
          secondary_window: { used_percent: 12, window_minutes: 10080 }
        }
      })
    });
    const r = await credit.lookupBalance({
      provider: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', cred: 'tok', fetchImpl: f
    });
    check('codex: asks /backend-api/wham/usage on the origin',
      f.calls.length === 1 && f.calls[0].url === 'https://chatgpt.com/backend-api/wham/usage',
      f.calls.map((c) => c.url).join(', '));
    check('codex: sends the ChatGPT access token',
      f.calls[0].init.headers.Authorization === 'Bearer tok');
    check('codex: reports the primary (session) window, rounded',
      r.ok && r.value === '62%', JSON.stringify(r));
    check('codex: labels the plan, never "Balance"', r.ok && r.label === 'Plan plus', JSON.stringify(r));
    check('codex: carries no dollar amount',
      r.ok && r.remaining === undefined && r.totalCredits === undefined, JSON.stringify(r));

    // The weekly window does not substitute for the session window.
    const weeklyOnly = credit.balanceFromCodexUsage({
      plan_type: 'pro', rate_limit: { secondary_window: { used_percent: 12 } }
    });
    check('codex: a payload with only the weekly window is not a number', weeklyOnly === null,
      JSON.stringify(weeklyOnly));

    // An unknown plan still yields the window, under a bare "Plan" label.
    const noPlan = credit.balanceFromCodexUsage({ rate_limit: { primary_window: { used_percent: 100.4 } } });
    check('codex: no plan type still reports the window, clamped at 100%',
      noPlan && noPlan.label === 'Plan' && noPlan.value === '100%', JSON.stringify(noPlan));

    // A flat rate_limit.primary_window (no nested object) is the other
    // plausible spelling; a bare number is accepted there too.
    const flat = credit.balanceFromCodexUsage({ rate_limit: { primary_window: 5 } });
    check('codex: accepts a bare number for the window', flat && flat.value === '5%', JSON.stringify(flat));

    // No window at all is "unsupported", never a guessed 0%.
    check('codex: a body with no window is not a number',
      credit.balanceFromCodexUsage({ plan_type: 'plus', rate_limit: {} }) === null);
    check('codex: a non-object body is not a number', credit.balanceFromCodexUsage(null) === null);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
