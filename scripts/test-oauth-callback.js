'use strict';

// Regression test for the iOS PWA / popup-blocked OAuth sign-in flow.
//
// The IdP (openrouter.ai, anthropic.com, github.com, ...) redirects the
// user's browser back to `/oauth/callback` in a *top-level navigation*, so
// the request legitimately carries a cross-site `Origin` and no access or
// session cookie (Safari's SVC isolation, popup denied, or the PWA opening
// the IdP in a new web-preview tab). Previously `authorizeBrowserRequest`
// and `authorizeAccessRequest` both rejected exactly that request with
// 403, so sign-in completed at the provider but the app never received the
// token — "shows in provider, error to redirect to the app".
//
// The callback must be reachable from any origin *without* a session, and
// must still refuse a callback whose `state` does not match a pending
// record (that is the real CSRF boundary — the state is a secret the
// authenticated app generated).
//
// The sandbox CI image has no OS keychain daemon (@napi-rs/keyring throws
// "KeyRevoked"), so we stub src/auth.js with an in-memory implementation
// before requiring the server — same technique as test-oauth-refresh.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('module');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-oauthcb-'));
process.env.MOUAIF_HOME = home;

// ---- auth.js stub (in-memory token store + pending records) -----------
const authRealPath = require.resolve('../src/auth.js');
delete require.cache[authRealPath];

const stub = (() => {
  const tokens = new Map();        // `${provider}/${account}` -> blob
  const pending = [];              // pending records
  const exchanges = new Map();
  const refreshers = new Map();
  return {
    SUPPORTED_PROVIDERS: ['openai', 'anthropic', 'google', 'github-copilot', 'openrouter'],
    SERVICE_PREFIX: 'mouaif',
    AI_TO_AUTH_PROVIDER: Object.freeze({ 'openrouter': 'openrouter' }),
    authProviderFor: (model) => model && model.provider,
    setToken: async (provider, account, blob) => { tokens.set(provider + '/' + account, blob); return { provider, account }; },
    getToken: (provider, account) => tokens.get(provider + '/' + account) || null,
    deleteToken: (provider, account) => { tokens.delete(provider + '/' + account); return { provider, account, deleted: true }; },
    listAccounts: () => {
      const out = {};
      for (const p of stub.SUPPORTED_PROVIDERS) out[p] = [];
      for (const k of tokens.keys()) {
        const [p, ...rest] = k.split('/');
        out[p].push(rest.join('/'));
      }
      return out;
    },
    resolveAccount: () => null,
    tokenForModel: () => null,
    recordPending: (provider, rec) => { pending.push(Object.assign({ provider }, rec)); },
    consumePending: (provider, state) => {
      const idx = pending.findIndex(p => p.provider === provider && p.state === state);
      if (idx === -1) return null;
      return pending.splice(idx, 1)[0];
    },
    clearPending: () => {},
    prunePending: () => 0,
    registerExchange: (p, fn) => exchanges.set(p, fn),
    getExchange: (p) => exchanges.get(p) || null,
    registerRefresher: (p, fn) => refreshers.set(p, fn),
    getRefresher: (p) => refreshers.get(p) || null,
    _tokens: tokens,
    _pending: pending
  };
})();

const stubModule = new Module(authRealPath);
stubModule.filename = authRealPath;
stubModule.loaded = true;
stubModule.exports = stub;
require.cache[authRealPath] = stubModule;

const { createServer } = require('../src/index.js');

// Stub exchange — the real OpenRouter/Anthropic/Copilot exchanges need
// live network calls; a fixed blob is enough to prove the redirect gate.
stub.registerExchange('openrouter', async ({ pending, code }) => ({
  accessToken: 'mock-key-' + code,
  refreshToken: null,
  expiresAt: null,
  scope: 'openrouter',
  account: 'mock-account'
}));

function get(port, urlPath, headers = {}) {
  return fetch('http://127.0.0.1:' + port + urlPath, { headers, redirect: 'manual' });
}

async function main() {
  const server = createServer(0, { authEnabled: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // --- 1. Cross-site IdP redirect with NO session/access cookie must be
    // reachable and must complete the exchange (matching pending state). ---
    stub.recordPending('openrouter', {
      state: 'openrouter:abc123',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:' + port + '/oauth/callback?provider=openrouter',
      scopes: 'openrouter'
    });
    // Simulate the exact request Safari/Chrome send on a top-level
    // navigation away from the IdP back to us.
    const cb = await get(port,
      '/oauth/callback?provider=openrouter&state=openrouter%3Aabc123&code=mockcode',
      { Origin: 'https://openrouter.ai', 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(cb.status, 200, 'cross-site IdP callback must not be 403/401');
    const html = await cb.text();
    assert.match(html, /Signed in/, 'callback page reports success');
    assert.match(html, /Redirecting back to the app/, 'callback page auto-redirects to the app');

    // --- 2. Same request WITHOUT an Origin header (curl / non-browser,
    // some privacy sandboxes) also works. ---
    stub.recordPending('openrouter', {
      state: 'openrouter:def456',
      codeVerifier: 'verifier2',
      redirectUri: 'http://127.0.0.1:' + port + '/oauth/callback?provider=openrouter',
      scopes: 'openrouter'
    });
    const cb2 = await get(port,
      '/oauth/callback?provider=openrouter&state=openrouter%3Adef456&code=mockcode2');
    assert.equal(cb2.status, 200, 'no-origin callback still works');
    assert.match(await cb2.text(), /Signed in/);

    // --- 3. Unknown state is still rejected (the CSRF boundary). ---
    const bad = await get(port,
      '/oauth/callback?provider=openrouter&state=openrouter%3Anope&code=mockcode3',
      { Origin: 'https://openrouter.ai' });
    assert.equal(bad.status, 400, 'forged state is rejected');
    const badBody = await bad.text();
    assert.match(badBody, /No pending sign-in/);
    // Error pages must NOT close the popup / redirect instantly — the user
    // needs to read the failure message first. They keep the plain 2s meta
    // refresh plus the manual return link.
    assert.doesNotMatch(badBody, /window\.opener/, 'error page has no instant popup-close JS');
    assert.doesNotMatch(badBody, /location\.replace/, 'error page has no instant redirect JS');
    assert.match(badBody, /Return now/, 'error page still offers the manual return link');

    // --- 4. The callback page carries the popup-close + fallback JS. ---
    stub.recordPending('openrouter', {
      state: 'openrouter:ghi789',
      codeVerifier: 'verifier3',
      redirectUri: 'http://127.0.0.1:' + port + '/oauth/callback?provider=openrouter',
      scopes: 'openrouter'
    });
    const withJs = await get(port,
      '/oauth/callback?provider=openrouter&state=openrouter%3Aghi789&code=again',
      { Origin: 'https://openrouter.ai' });
    const body = await withJs.text();
    assert.match(body, /window\.opener/, 'popup self-close fallback present');
    assert.match(body, /location\.replace/, 'non-popup fallback redirects into the app');
    assert.match(body, /Return now/, 'manual return link present');

    // --- 5. A same-origin /api/auth/* route stays protected. ---
    const api = await get(port, '/api/auth/accounts', { Origin: 'http://127.0.0.1:' + port });
    assert.equal(api.status, 401, 'API routes still require the browser session');

    // --- 6. Sign-in endpoint still works for the app (same-origin + session). ---
    // With authEnabled, the web UI first logs in via /api/access/login
    // (mouaif_access cookie) and holds the mouaif_session cookie from /web/.
    const page = await fetch('http://127.0.0.1:' + port + '/web/');
    const sessionCookie = String(page.headers.get('set-cookie') || '').split(';')[0];
    const accessAuth = require('../src/access-auth.js');
    accessAuth.setPassword('oauth-test', 'password');
    const login = await fetch('http://127.0.0.1:' + port + '/api/access/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:' + port, Cookie: sessionCookie },
      body: JSON.stringify({ username: 'oauth-test', password: 'password' })
    });
    assert.equal(login.status, 200, 'access login succeeds');
    const accessCookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    const signIn = await fetch('http://127.0.0.1:' + port + '/api/auth/sign-in/openrouter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:' + port, Cookie: sessionCookie + '; ' + accessCookie },
      body: JSON.stringify({ redirectUri: 'http://127.0.0.1:' + port + '/oauth/callback' })
    });
    assert.equal(signIn.status, 200, 'same-origin sign-in POST with session cookie is allowed');
    const signInBody = await signIn.json();
    assert.match(signInBody.authorizeUrl, /^https:\/\/openrouter\.ai\/auth/, 'authorize URL points at the IdP');

    console.log('oauth callback redirect flow: assertions passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
