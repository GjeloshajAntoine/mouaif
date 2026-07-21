'use strict';

// Smoke test for proactive OAuth refresh in src/ai.js.
//
// Replaces the real `./auth.js` module with an in-memory stub by
// pre-installing a stub module entry in require.cache at the
// resolved path of src/auth.js, so when ai.js calls
// `require('./auth.js')` it sees the stub instead.

const assert = require('assert');
const Module = require('module');

const authRealPath = require.resolve('../src/auth.js');
delete require.cache[authRealPath];

const stubObj = (() => {
  const store = new Map();
  const refresherByProvider = new Map();
  const AI_TO_AUTH_PROVIDER = Object.freeze({ 'anthropic': 'anthropic' });
  function authProviderFor(model) {
    if (!model || !model.provider) return null;
    if (Object.prototype.hasOwnProperty.call(AI_TO_AUTH_PROVIDER, model.provider)) {
      return AI_TO_AUTH_PROVIDER[model.provider];
    }
    return model.provider;
  }
  return {
    SUPPORTED_PROVIDERS: ['anthropic'],
    SERVICE_PREFIX: 'mouaif',
    AI_TO_AUTH_PROVIDER,
    authProviderFor,
    setToken: async (provider, account, blob) => { store.set(provider + '/' + account, blob); },
    getToken: (provider, account) => store.get(provider + '/' + account) || null,
    deleteToken: (provider, account) => { store.delete(provider + '/' + account); },
    listAccounts: () => ({ anthropic: Array.from(store.keys()).map(k => k.split('/')[1]) }),
    resolveAccount: () => 'me@example.com',
    tokenForModel: (m) => store.get(m.provider + '/' + 'me@example.com') || null,
    recordPending: () => {},
    consumePending: () => null,
    clearPending: () => {},
    registerExchange: () => {},
    getExchange: () => null,
    registerRefresher: (p, fn) => { refresherByProvider.set(p, fn); },
    getRefresher: (p) => refresherByProvider.get(p) || null,
    _store: store,
    _refreshers: refresherByProvider
  };
})();

// Pre-create the stub module file so require can resolve it via the
// real path. The file re-exports the stubObj from a side-channel.
const stubPath = require.resolve('./test-stubs/auth-stub.js');
// The stub file uses a Proxy that reads from a global. We just need
// the resolved module's exports object to be the stub. So we
// overwrite the cache entry with our own Module instance.
const stubModule = new Module(authRealPath);
stubModule.filename = authRealPath;
stubModule.loaded = true;
stubModule.exports = stubObj;
require.cache[authRealPath] = stubModule;

// Now load ai.js. It will require('./auth.js') and pick up our stub.
const ai = require('../src/ai.js');

(async () => {
  const now = Date.now();
  const KEY = 'anthropic/me@example.com';

  // ---- Case 1: near-expiry token + refresh_token present -> refresh
  await stubObj.setToken('anthropic', 'me@example.com', JSON.stringify({
    accessToken: 'OLD_TOKEN',
    refreshToken: 'OLD_REFRESH',
    expiresAt: now + 30 * 1000, // 30s, inside the 60s lead window
    scope: 'user:profile user:inference user:developer'
  }));
  let refreshCalls = 0;
  stubObj.registerRefresher('anthropic', async ({ refreshToken }) => {
    refreshCalls++;
    assert.strictEqual(refreshToken, 'OLD_REFRESH');
    return {
      accessToken: 'NEW_TOKEN',
      refreshToken: 'NEW_REFRESH',
      expiresAt: now + 60 * 60 * 1000,
      scope: 'user:profile user:inference user:developer',
      account: 'me@example.com'
    };
  });

  const origFetch = global.fetch;
  let seenAuth = null;
  global.fetch = async (url, init) => {
    seenAuth = (init && init.headers && init.headers.Authorization) || null;
    return new Response('{}', { status: 200 });
  };

  const model = {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    auth: 'oauth',
    authProvider: 'anthropic',
    oauthAccount: 'me@example.com'
  };
  await ai.streamChat({ model, messages: [{ role: 'user', content: 'hi' }], onEvent: () => {} });
  assert.strictEqual(refreshCalls, 1, 'refresher should be called exactly once for a near-expiry token');
  assert.strictEqual(seenAuth, 'Bearer NEW_TOKEN', 'outbound request uses the refreshed access token');
  let blob = JSON.parse(stubObj._store.get(KEY));
  assert.strictEqual(blob.accessToken, 'NEW_TOKEN', 'keychain blob has the new access token');
  assert.strictEqual(blob.refreshToken, 'NEW_REFRESH', 'keychain blob has the new refresh token');

  // ---- Case 2: token far from expiry -> no refresh
  await stubObj.setToken('anthropic', 'me@example.com', JSON.stringify({
    accessToken: 'STILL_GOOD',
    refreshToken: 'OLD_REFRESH',
    expiresAt: now + 24 * 60 * 60 * 1000,
    scope: 'user:profile user:inference user:developer'
  }));
  refreshCalls = 0; seenAuth = null;
  await ai.streamChat({ model, messages: [{ role: 'user', content: 'hi' }], onEvent: () => {} });
  assert.strictEqual(refreshCalls, 0, 'refresher must not be called when the token is far from expiry');
  assert.strictEqual(seenAuth, 'Bearer STILL_GOOD');

  // ---- Case 3: near-expiry but no refresh_token -> skip, use stored
  await stubObj.setToken('anthropic', 'me@example.com', JSON.stringify({
    accessToken: 'NO_REFRESH_AT_ALL',
    expiresAt: now + 10 * 1000,
    scope: 'user:profile user:inference user:developer'
  }));
  refreshCalls = 0; seenAuth = null;
  await ai.streamChat({ model, messages: [{ role: 'user', content: 'hi' }], onEvent: () => {} });
  assert.strictEqual(refreshCalls, 0, 'refresher must not be called when no refresh_token is stored');
  assert.strictEqual(seenAuth, 'Bearer NO_REFRESH_AT_ALL', 'use the stored token when no refresh is possible');

  // ---- Case 4: refresh fails -> fall through to stored token
  await stubObj.setToken('anthropic', 'me@example.com', JSON.stringify({
    accessToken: 'WILL_FAIL',
    refreshToken: 'BAD_REFRESH',
    expiresAt: now + 10 * 1000,
    scope: 'user:profile user:inference user:developer'
  }));
  stubObj.registerRefresher('anthropic', async () => { refreshCalls++; throw new Error('refresh failed'); });
  refreshCalls = 0; seenAuth = null;
  await ai.streamChat({ model, messages: [{ role: 'user', content: 'hi' }], onEvent: () => {} });
  assert.strictEqual(refreshCalls, 1, 'refresher is still called even when it will fail');
  assert.strictEqual(seenAuth, 'Bearer WILL_FAIL', 'on refresh failure, fall through to the stored token');

  global.fetch = origFetch;
  // eslint-disable-next-line no-console
  console.log('OK — oauth proactive refresh behaves as expected across all four cases.');
})().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('FAIL:', e && e.stack || e);
  process.exit(1);
});
