'use strict';

// Regression test: a proactive OAuth refresh must persist the new token
// under the account it was read from.
//
// A model with auth='oauth' and no explicit oauthAccount resolves its
// token through the single-signed-in-account fallback in src/auth.js.
// The refresh path in src/ai-endpoints.js used to persist the refreshed
// blob under `model.oauthAccount || parsed.account || 'default'` — and
// neither of the first two is set in that case — so it wrote a second
// 'default' account. With two accounts indexed, the fallback stopped
// resolving and the *next* chat failed with ENOAUTH ("No OAuth account
// is signed in") until the user signed in again.
//
// Uses the real src/auth.js with an in-memory @napi-rs/keyring, so the
// account index and the fallback are exercised end to end.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('module');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-oauth-acct-'));

const srcDir = path.join(__dirname, '..', 'src');
const keyringPath = require.resolve('@napi-rs/keyring', { paths: [srcDir] });
const keychain = new Map();
class Entry {
  constructor(service, account) { this.key = service + '|' + account; }
  setPassword(p) { keychain.set(this.key, p); }
  getPassword() {
    if (!keychain.has(this.key)) throw new Error('No matching entry found in secure storage');
    return keychain.get(this.key);
  }
  deletePassword() {
    if (!keychain.delete(this.key)) throw new Error('No matching entry found in secure storage');
  }
}
const keyringStub = new Module(keyringPath);
keyringStub.filename = keyringPath;
keyringStub.loaded = true;
keyringStub.exports = { Entry };
require.cache[keyringPath] = keyringStub;

const auth = require('../src/auth.js');
const ai = require('../src/ai.js');

(async () => {
  const ACCOUNT = 'me@example.com';
  await auth.setToken('anthropic', ACCOUNT, JSON.stringify({
    accessToken: 'OLD_TOKEN',
    refreshToken: 'OLD_REFRESH',
    expiresAt: Date.now() + 5 * 1000 // inside the refresh lead window
  }));

  let refreshCalls = 0;
  auth.registerRefresher('anthropic', async () => {
    refreshCalls++;
    // No `account` in the result, as with a refresh response that does
    // not echo the account object.
    return { accessToken: 'NEW_TOKEN', refreshToken: 'NEW_REFRESH', expiresAt: Date.now() + 3600 * 1000 };
  });

  const seen = [];
  const origFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const h = (init && init.headers) || {};
    seen.push(h.Authorization || h['x-api-key'] || null);
    return new Response('{}', { status: 200 });
  };

  // No oauthAccount: relies on the single-account fallback.
  const model = () => ({ id: 'claude-test', provider: 'anthropic', auth: 'oauth' });
  const msgs = [{ role: 'user', content: 'hi' }];

  try {
    const first = await ai.streamChat({ model: model(), messages: msgs, onEvent: () => {} });
    assert.equal(first.ok, true, 'first chat succeeds: ' + JSON.stringify(first.error));
    assert.equal(refreshCalls, 1, 'near-expiry token is refreshed');
    assert.equal(seen[0], 'Bearer NEW_TOKEN', 'first request uses the refreshed token');

    assert.deepEqual(auth.listAccounts().anthropic, [ACCOUNT],
      'refresh must not add a second ("default") account to the index');
    const blob = JSON.parse(auth.getToken('anthropic', ACCOUNT));
    assert.equal(blob.accessToken, 'NEW_TOKEN', 'refreshed blob replaces the original account entry');
    assert.equal(blob.refreshToken, 'NEW_REFRESH');
    assert.equal(auth.getToken('anthropic', 'default'), null, 'no stray "default" keychain entry');

    const second = await ai.streamChat({ model: model(), messages: msgs, onEvent: () => {} });
    assert.equal(second.ok, true, 'second chat still resolves the account: ' + JSON.stringify(second.error));
    assert.equal(refreshCalls, 1, 'fresh token is not refreshed again');
    assert.equal(seen[1], 'Bearer NEW_TOKEN', 'second request uses the persisted refreshed token');
  } finally {
    global.fetch = origFetch;
  }

  console.log('OK — OAuth refresh persists under the resolved account.');
})().catch((e) => {
  console.error('FAIL:', (e && e.stack) || e);
  process.exit(1);
});
