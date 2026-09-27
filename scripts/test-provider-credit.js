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
  check('openai-compatible is OpenAI-shaped', credit.supportsOpenAIShaped('openai-compatible'));
  check('mistral and groq are OpenAI-shaped',
    credit.supportsOpenAIShaped('mistral') && credit.supportsOpenAIShaped('groq'));
  check('deepseek is OpenAI-shaped', credit.supportsOpenAIShaped('deepseek'));
  check('openrouter is NOT routed through the OpenAI billing shape',
    !credit.supportsOpenAIShaped('openrouter'));
  check('anthropic/gemini are not OpenAI-shaped',
    !credit.supportsOpenAIShaped('anthropic') && !credit.supportsOpenAIShaped('gemini'));

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
    const r = await credit.lookupOpenAIShaped({
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
    const r = await credit.lookupOpenAIShaped({
      provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', cred: 'k', fetchImpl: f
    });
    check('grants: string amounts are accepted', r.ok && r.remaining === 3.42, JSON.stringify(r));
  }

  // ---- grants with no total_available: derive it -----------------------
  {
    const f = fakeFetch({
      '/dashboard/billing/credit_grants': jsonResponse({ total_granted: 10, total_used: 4 })
    });
    const r = await credit.lookupOpenAIShaped({
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
    const r = await credit.lookupOpenAIShaped({
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
    const r = await credit.lookupOpenAIShaped({
      provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', cred: 'k', fetchImpl: f
    });
    check('subscription: over-spend floors at 0', r.ok && r.remaining === 0, JSON.stringify(r));
  }

  // ---- a local server answers nothing usable ---------------------------
  {
    const f = fakeFetch({});
    const r = await credit.lookupOpenAIShaped({
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
    const r = await credit.lookupOpenAIShaped({
      provider: 'openai-compatible', baseUrl: 'https://gateway.example/v1', cred: 'k', fetchImpl: f
    });
    check('unparseable body: unsupported, never a guessed number',
      r.ok === false && r.code === 'EUPSTREAM', JSON.stringify(r));
  }

  // ---- transport failure is its own code -------------------------------
  {
    const f = fakeFetch({}, { throwOn: /credit_grants/ });
    const r = await credit.lookupOpenAIShaped({
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
    const r = await credit.lookupOpenAIShaped({
      provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', cred: 'k', fetchImpl: f
    });
    check('subscription without a usage answer reports the full limit',
      r.ok && r.remaining === 12 && r.totalUsage === 0, JSON.stringify(r));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
