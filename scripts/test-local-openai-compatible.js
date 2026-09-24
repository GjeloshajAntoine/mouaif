'use strict';

// Local OpenAI-shaped servers — llama.cpp's `llama-server`, LM Studio.
//
// The openai-compatible provider is the connection people point at a local
// server, and those servers (a) run unauthenticated and (b) live at a
// user-chosen base URL (http://127.0.0.1:8080/v1 for llama.cpp). Three
// defects made that fail:
//
//   1. `requireApiKey` rejected a keyless openai-compatible model with
//      ENOAPIKEY, so a keyless chat never reached the wire.
//   2. `buildOpenAIRequest` built `Authorization: Bearer undefined` for a
//      keyless model — worse than sending nothing.
//   3. `ENDPOINTS['openai-compatible'].listModels` hard-coded
//      api.openai.com, so the picker's refresh listed OpenAI's models no
//      matter which local server the connection pointed at.
//
// This test pins the fix without the network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-local-oai-home-'));
process.env.MOUAIF_HOME = home;

const ai = require('../src/ai-endpoints.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

function withStubbedFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(() => fn()).finally(() => { global.fetch = orig; });
}

async function main() {
  // ---- 1. Live model list honors the connection's base URL ----------
  let lastUrl = null;
  let lastHeaders = null;
  await withStubbedFetch(async (url, opts) => {
    lastUrl = url; lastHeaders = (opts && opts.headers) || {};
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [{ id: 'local-gguf-model' }] }) };
  }, async () => {
    const out = await ai.listModels('openai-compatible', null, undefined, 'http://127.0.0.1:8080/v1');
    check('base URL: queries the local server, not api.openai.com',
      /^http:\/\/127\.0\.0\.1:8080\/v1\/models$/.test(lastUrl), 'lastUrl=' + lastUrl);
    check('base URL: trailing slash is collapsed',
      !/v1\/\/models/.test(lastUrl));
    check('base URL: keyless request sends no Authorization header',
      !Object.keys(lastHeaders).some((h) => /authorization/i.test(h)), JSON.stringify(lastHeaders));
    check('base URL: returns the local catalog',
      out.length === 1 && out[0].id === 'local-gguf-model');
  });

  // ---- 2. No base URL falls back to the hosted OpenAI default --------
  await withStubbedFetch(async (url) => {
    lastUrl = url;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [{ id: 'gpt-4o' }] }) };
  }, async () => {
    await ai.listModels('openai-compatible', 'sk-test', undefined, null);
    check('no base URL: falls back to api.openai.com/v1',
      lastUrl === 'https://api.openai.com/v1/models', 'lastUrl=' + lastUrl);
  });

  // ---- 3. requireApiKey allows a keyless local connection -----------
  const def = ai.ENDPOINTS['openai-compatible'];
  check('keyOptional flag is set on openai-compatible', def.keyOptional === true);
  let allowed = false;
  try { allowed = await ai.requireApiKey({ id: 'local', provider: 'openai-compatible' }, def); }
  catch (e) { allowed = false; }
  check('keyless openai-compatible passes requireApiKey', allowed === true);

  // ...but a hosted provider that needs a key still refuses.
  let mistralErr = null;
  try { await ai.requireApiKey({ id: 'mistral-large', provider: 'mistral' }, ai.ENDPOINTS.mistral); }
  catch (e) { mistralErr = e; }
  check('keyless mistral still throws ENOAPIKEY',
    mistralErr && mistralErr.code === 'ENOAPIKEY', mistralErr && mistralErr.code);

  // ---- 4. The builder omits the auth header when keyless ------------
  const keyless = ai.BUILDERS['openai-compatible'](
    { id: 'local', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1' },
    [{ role: 'user', content: 'hi' }], true
  );
  check('keyless builder: URL points at the local server',
    keyless.url === 'http://127.0.0.1:8080/v1/chat/completions', 'url=' + keyless.url);
  check('keyless builder: no Authorization header',
    !Object.keys(keyless.headers).some((h) => /authorization/i.test(h)), JSON.stringify(keyless.headers));

  const withKey = ai.BUILDERS['openai-compatible'](
    { id: 'gpt-4o', provider: 'openai-compatible', apiKey: 'sk-live' },
    [{ role: 'user', content: 'hi' }], true
  );
  check('keyed builder: still sends the Bearer header',
    withKey.headers.Authorization === 'Bearer sk-live', JSON.stringify(withKey.headers));

  console.log('\n---');
  console.log('passed: ' + passed);
  console.log('failed: ' + failed);
  if (failed) process.exit(1);
}

main();
