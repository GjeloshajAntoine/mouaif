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
    const route = routes[pathname];
    if (!route) return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
    const body = typeof route === 'function' ? route() : route;
    return { ok: true, status: 200, json: async () => body };
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
    stubUpstream(stubRoutes, { serverOrigin: origin, throwFor: stubThrow });
    try {
      const r = await fetch(origin + '/api/ai/provider-credit?provider=' + encodeURIComponent(provider));
      return { status: r.status, body: await r.json() };
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  let stubRoutes = {};
  let stubThrow = null;

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

    // ---- the cloud providers that share the OpenAI shape --------------
    setProviders([{ id: 'mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'k' }]);
    stubRoutes = { '/dashboard/billing/credit_grants': { total_available: 7.5 } };
    r = await get('mistral');
    check('mistral: routed through the OpenAI billing lookup',
      r.status === 200 && r.body.remaining === 7.5, JSON.stringify(r.body));

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
