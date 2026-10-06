'use strict';

// Tests for GET /api/ai/provider-credit — the route that feeds the chat head's
// "Balance" pill.
//
// The route used to answer for OpenRouter only. It now also answers for the
// OpenAI-shaped connections (OpenAI compatible, Mistral, Groq, DeepSeek) by
// asking the OpenAI billing routes, and it must keep three things true:
//
//   * a provider it cannot price answers `{ supported: false }` with a 200, so
//     the chat head hides the pill instead of showing a failure;
//   * a connection with no credential is not an error for a local
//     OpenAI-shaped server (the key is optional there);
//   * an unreachable provider is a 503, which is a real fact worth reporting.
//
// The upstream is stubbed at globalThis.fetch, exactly like the sibling
// provider tests do, so nothing here leaves the machine.

const path = require('path');
const fs = require('fs');
const os = require('os');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-provider-credit-'));
process.env.MOUAIF_HOME = home;

const { createServer } = require('../src/index.js');
const settings = require('../src/settings.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail !== undefined ? '  -- ' + detail : '')); }
}

const realFetch = globalThis.fetch;
let calls = [];

// Stub every upstream call: the route's own fetches land here too, so the
// stub must fall through to the real fetch for the test's own HTTP requests to
// the local server.
function stubUpstream(routes, opts = {}) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(opts.serverOrigin || '\u0000')) return realFetch(url, init);
    calls.push({ url: href, init });
    if (opts.throwFor && opts.throwFor.test(href)) throw new Error('connect ECONNREFUSED');
    const pathname = new URL(href).pathname;
    // A status override lets a case assert how an auth failure upstream (a
    // workspace key hitting Mistral's admin-only route) is reported.
    const status = (opts.statusFor && opts.statusFor[pathname]) || 200;
    const route = routes[pathname];
    if (!route) return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
    const body = typeof route === 'function' ? route() : route;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

function setProviders(list) {
  settings.setApp({ providers: list });
}

async function main() {
  const server = createServer(0, {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const get = async (provider) => {
    stubUpstream(stubRoutes, { serverOrigin: origin, throwFor: stubThrow, statusFor: stubStatus });
    try {
      const r = await fetch(origin + '/api/ai/provider-credit?provider=' + encodeURIComponent(provider));
      return { status: r.status, body: await r.json() };
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  let stubRoutes = {};
  let stubThrow = null;
  let stubStatus = {};

  try {
    // ---- providers with no balance concept ----------------------------
    setProviders([{ id: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-x' }]);
    let r = await get('anthropic');
    check('anthropic: supported=false', r.status === 200 && r.body.supported === false,
      r.status + ' ' + JSON.stringify(r.body));
    check('anthropic: no upstream call was made', calls.length === 0);

    r = await get('ollama');
    check('ollama: supported=false', r.status === 200 && r.body.supported === false);

    // ---- OpenAI-shaped, prepaid credit grants -------------------------
    setProviders([{ id: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-upstream' }]);
    stubRoutes = {
      '/dashboard/billing/credit_grants': { total_granted: 20, total_used: 16.58, total_available: 3.42 }
    };
    r = await get('openai-compatible');
    check('openai-compatible: grants become a balance',
      r.status === 200 && r.body.supported === true && r.body.remaining === 3.42,
      r.status + ' ' + JSON.stringify(r.body));
    check('openai-compatible: labelled Balance', r.body.label === 'Balance');
    check('openai-compatible: totals forwarded',
      r.body.totalCredits === 20 && r.body.totalUsage === 16.58);
    check('openai-compatible: asked the configured origin, not /v1',
      calls.length === 1 && calls[0].url === 'https://api.openai.com/dashboard/billing/credit_grants',
      calls.map((c) => c.url).join(', '));
    check('openai-compatible: forwarded the stored key',
      calls[0].init.headers.Authorization === 'Bearer sk-upstream');

    // ---- OpenAI-shaped, usage-capped account --------------------------
    stubRoutes = {
      '/dashboard/billing/subscription': { hard_limit_usd: 20, soft_limit_usd: 18 },
      '/dashboard/billing/usage': { total_usage: 1658 }
    };
    r = await get('openai-compatible');
    check('openai-compatible: subscription limit minus usage',
      r.status === 200 && r.body.supported === true && Math.abs(r.body.remaining - 3.42) < 1e-9,
      JSON.stringify(r.body));

    // ---- a self-hosted server with no key -----------------------------
    setProviders([{ id: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1' }]);
    stubRoutes = {};
    r = await get('openai-compatible');
    check('keyless local server: supported=false, not an error',
      r.status === 200 && r.body.supported === false, r.status + ' ' + JSON.stringify(r.body));

    // ---- a keyed endpoint that answers no balance ---------------------
    setProviders([{ id: 'openai-compatible', baseUrl: 'https://gateway.example/v1', apiKey: 'k' }]);
    stubRoutes = {};
    r = await get('openai-compatible');
    check('keyed gateway without billing: supported=false at 200',
      r.status === 200 && r.body.supported === false, r.status + ' ' + JSON.stringify(r.body));

    // ---- unreachable ---------------------------------------------------
    stubRoutes = {};
    stubThrow = /credit_grants/;
    r = await get('openai-compatible');
    check('unreachable provider: 503 with EUNREACHABLE',
      r.status === 503 && r.body.code === 'EUNREACHABLE', r.status + ' ' + JSON.stringify(r.body));
    stubThrow = null;

    // ---- Mistral reads its own Admin API spend limit --------------------
    // /v1/admin/spend-limit, with the key sent under both documented header
    // names (the prose guide says x-api-key, the OpenAPI scheme says bearer).
    // Amounts are whole numbers in the billing currency, so the remaining
    // balance is usage_limit - total_usage with no cents division.
    setProviders([{ id: 'mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'admin-key' }]);
    calls.length = 0;
    stubRoutes = {
    '/v1/admin/spend-limit': {
      limits: {
      completion: { no_monthly_limit: false, monthly_limit_reached: false, total_usage: 12.5, usage_limit: 500 },
      currency: 'USD'
      }
    }
    };
    r = await get('mistral');
    check('mistral: reads /v1/admin/spend-limit',
    r.status === 200 && r.body.supported === true && r.body.remaining === 487.5,
    JSON.stringify(r.body));
    check('mistral: used the Admin API path, not the OpenAI billing routes',
    calls.length === 1 && calls[0].url === 'https://api.mistral.ai/v1/admin/spend-limit',
    calls.map((c) => c.url).join(', '));
    check('mistral: sends the key under BOTH header names',
    calls[0].init && calls[0].init.headers
    && calls[0].init.headers['x-api-key'] === 'admin-key'
    && calls[0].init.headers.Authorization === 'Bearer admin-key',
    JSON.stringify(calls[0].init && calls[0].init.headers));

    // An uncapped account has no ceiling to subtract from: no pill, no guess.
    stubRoutes = {
    '/v1/admin/spend-limit': { limits: { completion: { no_monthly_limit: true, total_usage: 12.5 }, currency: 'USD' } }
    };
    r = await get('mistral');
    check('mistral: no_monthly_limit shows no pill rather than a guessed number',
    r.status === 200 && r.body.supported === false, JSON.stringify(r.body));

    // A workspace key is rejected by the Admin API (401) — that reads as "no
    // balance", not as an error the user cannot act on.
    stubRoutes = {};
    stubStatus['/v1/admin/spend-limit'] = 401;
    r = await get('mistral');
    check('mistral: a workspace key (401) reports no balance, not an error',
    r.status === 200 && r.body.supported === false, r.status + ' ' + JSON.stringify(r.body));
    delete stubStatus['/v1/admin/spend-limit'];

    // ---- Groq publishes no balance API at all ---------------------------
    setProviders([{ id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' }]);
    calls.length = 0;
    r = await get('groq');
    check('groq: unsupported, no balance route exists',
    r.status === 200 && r.body.supported === false, JSON.stringify(r.body));
    check('groq: no request was made',
    calls.length === 0, calls.map((c) => c.url).join(', '));

    // ---- DeepSeek reads its own /user/balance route ---------------------
    setProviders([{ id: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'k' }]);
    calls.length = 0;
    stubRoutes = {
      '/user/balance': { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.25' }] }
    };
    r = await get('deepseek');
    check('deepseek: reads its own /user/balance route',
      r.status === 200 && r.body.supported === true && r.body.remaining === 4.25,
      JSON.stringify(r.body));
    check('deepseek: did not ask the OpenAI billing routes',
      calls.length === 1 && calls[0].url === 'https://api.deepseek.com/user/balance',
      calls.map((c) => c.url).join(', '));

    // ---- OpenRouter keeps its own endpoint ----------------------------
    setProviders([{ id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-x' }]);
    stubRoutes = { '/api/v1/credits': { data: { total_credits: 10, total_usage: 7.25 } } };
    r = await get('openrouter');
    check('openrouter: unchanged, still uses /credits',
      r.status === 200 && r.body.supported === true && Math.abs(r.body.remaining - 2.75) < 1e-9,
      JSON.stringify(r.body));
    check('openrouter: no OpenAI billing route was tried',
      calls.length === 1 && calls[0].url === 'https://openrouter.ai/api/v1/credits',
      calls.map((c) => c.url).join(', '));

    // OpenRouter without a key stays a hard error (it cannot list at all).
    setProviders([]);
    r = await get('openrouter');
    check('openrouter without a key: 400 ENO_APIKEY',
      r.status === 400 && r.body.code === 'ENO_APIKEY', r.status + ' ' + JSON.stringify(r.body));
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(1);
  }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((err) => {
  globalThis.fetch = realFetch;
  console.error(err && err.stack || err);
  process.exit(1);
});
