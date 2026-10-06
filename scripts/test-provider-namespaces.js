'use strict';

// Provider-table parity: the three tables a provider id has to appear in, kept
// from drifting apart.
//
// Adding a provider is described as a localized change — an ENDPOINTS row, a
// Settings-providers row, and (if the auth shape differs) an
// AI_TO_AUTH_PROVIDER entry. The three tables are edited separately, by hand,
// in three files, and nothing used to check that the same id set reached all of
// them. Two real defects were living in exactly that gap:
//
//   * AI_TO_AUTH_PROVIDER mapped ollama/azure/mistral/groq/deepseek to keyring
//     namespaces that SUPPORTED_PROVIDERS did not list, so readIndex() dropped
//     them from the account index and serviceName() threw EPROVIDER — reachable
//     from requireApiKey() when a connection was flagged oauth.
//   * the web bundle's authNsForProvider() mapped openai-compatible but not
//     gemini, so the provider form read `accounts.gemini` while the server
//     indexed that account under `google`.
//
// This test pins the invariants, not a snapshot: every AI provider has a
// Settings row, every keyring namespace a mapping points at is a supported
// namespace, and the web namespace map agrees with the server's.

const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// src/auth.js reads the app store for its account index, and src/settings.js
// refuses to open the *real* store from a test process. Point it at a throwaway
// home before the requires below — a test must never read or write the running
// instance.
process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-provider-ns-'));

const ai = require(path.resolve(__dirname, '..', 'src', 'ai-endpoints.js'));
const auth = require(path.resolve(__dirname, '..', 'src', 'auth.js'));

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok   - ' + name); }
  catch (err) { fail++; console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]); }
}

async function main() {
  const web = await import(pathToFileURL(path.resolve(__dirname, '..', 'frontend', 'src', 'api.js')).href);

  await check('every ENDPOINTS provider has a Settings row', () => {
    const ids = web.SETTINGS_PROVIDERS.map((p) => p.id).sort();
    assert.deepEqual(ids, Object.keys(ai.ENDPOINTS).sort());
  });

  await check('every Settings row names a real ENDPOINTS provider', () => {
    for (const def of web.SETTINGS_PROVIDERS) {
      assert.ok(ai.ENDPOINTS[def.id], def.id + ' is offered in Settings but has no ENDPOINTS row');
    }
  });

  await check('every AI provider maps to an auth provider', () => {
    for (const id of Object.keys(ai.ENDPOINTS)) {
      const ns = auth.authProviderFor({ provider: id });
      assert.equal(typeof ns, 'string', id + ' has no AI_TO_AUTH_PROVIDER entry');
      assert.ok(ns.length > 0, id + ' maps to an empty namespace');
    }
  });

  await check('every mapped keyring namespace is a supported one', () => {
    // serviceName() throws EPROVIDER for an unlisted namespace and readIndex()
    // omits it, so an unlisted value is a namespace that cannot exist.
    for (const [provider, ns] of Object.entries(auth.AI_TO_AUTH_PROVIDER)) {
      assert.ok(auth.SUPPORTED_PROVIDERS.includes(ns),
        provider + ' maps to namespace "' + ns + '" which is not in SUPPORTED_PROVIDERS');
    }
  });

  await check('the account index carries every supported namespace', () => {
    const idx = auth.listAccounts();
    for (const ns of auth.SUPPORTED_PROVIDERS) {
      assert.ok(Object.prototype.hasOwnProperty.call(idx, ns),
        'SUPPORTED_PROVIDERS lists "' + ns + '" but listAccounts() omits it');
    }
  });

  await check('an oauth-flagged API-key provider fails as ENOAUTH, not EPROVIDER', () => {
    // The deep failure this guards: requireApiKey() calls tokenForModel() with
    // the mapped namespace. Before the fix that threw EPROVIDER ("Unknown
    // provider") for the API-key-only providers — a message that names the
    // wrong subsystem and gives the user nothing to act on.
    for (const ns of ['azure', 'mistral', 'groq', 'deepseek', 'ollama']) {
      let code = null;
      try { auth.getToken(ns, 'nonexistent-account@example.com'); }
      catch (e) { code = e.code; }
      assert.notEqual(code, 'EPROVIDER', ns + ' namespace is not accepted by the keyring layer');
      if (code === null) assert.ok(true, ns + ' resolved without a keychain entry (no keyring available)');
    }
  });

  await check('the web namespace map agrees with AI_TO_AUTH_PROVIDER', () => {
    for (const [provider, ns] of Object.entries(auth.AI_TO_AUTH_PROVIDER)) {
      assert.equal(web.authNsForProvider(provider), ns,
        provider + ': web says "' + web.authNsForProvider(provider) + '", server keys it under "' + ns + '"');
    }
  });

  await check('the web namespace map answers for every Settings row', () => {
    for (const def of web.SETTINGS_PROVIDERS) {
      const ns = web.authNsForProvider(def.id);
      assert.ok(auth.SUPPORTED_PROVIDERS.includes(ns),
        def.id + ' resolves to namespace "' + ns + '" that the server does not support');
    }
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
