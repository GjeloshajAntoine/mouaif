// The add-provider catalog and the rules the form applies to it: every choice
// names a real provider, nothing pre-fills an address that can't work, and an
// answer from the model list reads as the right connection status.
import assert from 'node:assert/strict';
import { SETTINGS_PROVIDERS } from '../frontend/src/api.js';
import {
  PROVIDER_CHOICE_GROUPS, baseUrlProblem, connectionHealth, healthWithoutAsking, keyIsRequired, providerChoice, uniqueName
} from '../frontend/src/providerChoices.js';

const choices = PROVIDER_CHOICE_GROUPS.flatMap((group) => group.choices);
const def = (type) => SETTINGS_PROVIDERS.find((p) => p.id === type);

// ---- The catalog ------------------------------------------------------

assert.equal(new Set(choices.map((c) => c.key)).size, choices.length, 'choice keys are unique');
for (const c of choices) {
  assert.ok(def(c.type), c.key + ' names a real provider');
  assert.ok(c.auth === 'apikey' || c.auth === 'oauth', c.key + ' says how it connects');
  assert.equal(providerChoice(c.key).key, c.key, c.key + ' resolves from its route');
  if (c.auth === 'oauth') assert.ok(def(c.type).oauth, c.key + ' signs in, so its provider must offer it');
}
for (const p of SETTINGS_PROVIDERS) {
  assert.ok(choices.some((c) => c.type === p.id), p.id + ' can be added');
}
for (const c of choices) {
  const start = c.baseUrl !== undefined ? c.baseUrl : (def(c.type).defaultBaseUrl || '');
  const required = !!c.urlRequired || !def(c.type).defaultBaseUrl;
  if (start) assert.equal(baseUrlProblem(start, { required }), '', c.key + ' starts from a usable address');
  if (!start) assert.ok(required, c.key + ' starts empty, so it has to ask for an address');
}
assert.equal(providerChoice('nope'), null);
assert.equal(providerChoice(undefined), null);
for (const local of ['ollama', 'lm-studio', 'llama-cpp']) {
  assert.ok(providerChoice(local).local && providerChoice(local).hint, local + ' explains which address to use');
}

// ---- Is a key needed? --------------------------------------------------

assert.equal(keyIsRequired('anthropic', 'https://api.anthropic.com'), true);
assert.equal(keyIsRequired('ollama', 'http://127.0.0.1:11434'), false);
assert.equal(keyIsRequired('openai-compatible', 'https://api.openai.com/v1'), true, 'OpenAI itself needs a key');
assert.equal(keyIsRequired('openai-compatible', 'http://127.0.0.1:1234/v1'), false, 'a local server may not');
assert.equal(keyIsRequired('openai-compatible', ''), false);

// ---- Addresses ---------------------------------------------------------

assert.equal(baseUrlProblem('https://api.example.com/v1'), '');
assert.equal(baseUrlProblem('http://192.168.1.50:1234/v1'), '');
assert.equal(baseUrlProblem('', { required: false }), '');
assert.match(baseUrlProblem('', { required: true }), /Enter the API address/);
assert.match(baseUrlProblem('https://<resource>.openai.azure.com/openai/deployments/<deployment>'), /angle brackets/);
assert.match(baseUrlProblem('api.example.com'), /http:\/\/ or https:\/\//);
assert.match(baseUrlProblem('ftp://example.com'), /http:\/\/ or https:\/\//);

// ---- Connection status -------------------------------------------------

const key = { auth: 'apikey', hasApiKey: true };
assert.deepEqual(connectionHealth(200, { models: [{}, {}] }, key), { state: 'ok', text: 'Connected · 2 models', detail: '' });
assert.equal(connectionHealth(200, { models: [{}] }, key).text, 'Connected · 1 model');
assert.equal(connectionHealth(400, { code: 'ENO_LIST', error: 'x' }, key).state, 'unknown', 'no list is not a failure');
assert.equal(connectionHealth(400, { code: 'ENO_APIKEY' }, { auth: 'apikey' }).text, 'Needs an API key');
assert.equal(connectionHealth(400, { code: 'ENO_APIKEY' }, { auth: 'oauth' }).text, 'Needs sign-in');
assert.equal(connectionHealth(503, { code: 'EUNREACHABLE' }, key).text, 'Can\'t reach the server');
assert.equal(connectionHealth(504, { code: 'ETIMEOUT' }, key).text, 'No answer from the server');
assert.equal(connectionHealth(401, { code: 'EUPSTREAM', upstreamStatus: 401 }, key).text, 'API key rejected');
assert.equal(connectionHealth(401, { code: 'EUPSTREAM', upstreamStatus: 401 }, { auth: 'apikey', hasApiKey: false }).text, 'Needs an API key');
assert.equal(connectionHealth(403, { code: 'EUPSTREAM', upstreamStatus: 403 }, { auth: 'oauth' }).text, 'Sign-in rejected');
assert.equal(connectionHealth(404, { code: 'EUPSTREAM', upstreamStatus: 404 }, key).text, 'Nothing found at this address');
assert.equal(connectionHealth(500, { code: 'EUPSTREAM', upstreamStatus: 500, error: 'boom' }, key).text, 'Provider error (HTTP 500)');
assert.equal(connectionHealth(500, { code: 'EUPSTREAM', upstreamStatus: 500, error: 'boom' }, key).detail, 'boom');
assert.equal(connectionHealth(502, null, key).state, 'error');

// A list that answers with any key, or none, must not read as connected.
for (const type of ['anthropic', 'openrouter']) {
  assert.equal(healthWithoutAsking({ id: type, type, auth: 'apikey', hasApiKey: true }).state, 'unknown', type + ' with a key');
  assert.equal(healthWithoutAsking({ id: type, type, auth: 'oauth' }).state, 'unknown', type + ' signed in');
  assert.equal(healthWithoutAsking({ id: type, type, auth: 'apikey', hasApiKey: false }).text, 'Needs an API key', type + ' with no key');
}
assert.equal(healthWithoutAsking({ id: 'groq-2', type: 'groq', auth: 'apikey', hasApiKey: false }).text, 'Needs an API key', 'read by type, not id');
assert.equal(healthWithoutAsking({ id: 'groq', type: 'groq', auth: 'apikey', hasApiKey: true }), null, 'the server is asked');
assert.equal(healthWithoutAsking({ id: 'ollama', type: 'ollama', auth: 'apikey', hasApiKey: false }), null, 'Ollama needs no key');
assert.equal(healthWithoutAsking({ id: 'openai-compatible-2', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' }), null, 'a local server needs no key');
assert.equal(healthWithoutAsking({ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' }).state, 'error', 'OpenAI itself does');
assert.equal(healthWithoutAsking({ id: 'github-copilot', type: 'github-copilot', auth: 'oauth' }).state, 'unknown', 'Copilot falls back to a built-in list');

// ---- Names -------------------------------------------------------------

assert.equal(uniqueName('LM Studio', []), 'LM Studio');
assert.equal(uniqueName('LM Studio', ['LM Studio']), 'LM Studio 2');
assert.equal(uniqueName('LM Studio', ['LM Studio', 'LM Studio 2']), 'LM Studio 3');

console.log('PASS provider choices: catalog, key rule, addresses, connection status, names');
