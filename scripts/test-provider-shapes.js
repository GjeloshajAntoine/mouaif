'use strict';

// src/providerShapes.js — one answer to "does this connection speak the
// OpenAI shape?".
//
// The list used to be copy-pasted into two consumer modules, and the two
// copies had already drifted: transcribe's carried an `anthropic` entry the
// image module did not. That is not a cosmetic difference — the
// audio path used the list to decide whether to reroute a row to
// `/chat/completions`, so the extra entry pointed a Claude connection at an
// endpoint that does not exist. This test pins the list's *content*, not just
// its consumers, so a later edit that re-adds Anthropic or Gemini fails here
// with the reason written down.

const assert = require('node:assert/strict');
const path = require('node:path');

const shapes = require(path.resolve(__dirname, '..', 'src', 'providerShapes.js'));
const endpoints = require(path.resolve(__dirname, '..', 'src', 'ai-endpoints.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   - ' + name); }
  catch (err) { fail++; console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]); }
}

check('the list names exactly the shipped OpenAI-shaped providers', () => {
  assert.deepEqual([...shapes.OPENAI_SHAPED_PROVIDERS].sort(), [
    'azure', 'deepseek', 'github-copilot', 'groq', 'mistral',
    'ollama', 'openai-compatible', 'openrouter'
  ].sort());
});

check('every listed provider has an ENDPOINTS row that really is OpenAI-shaped', () => {
  for (const id of shapes.OPENAI_SHAPED_PROVIDERS) {
    const def = endpoints.ENDPOINTS[id];
    assert.ok(def, id + ' is listed as OpenAI-shaped but has no ENDPOINTS row');
    if (id === 'ollama') {
      // The exception, and it is a deliberate one: Ollama's *native* chat is
      // NDJSON at /api/chat, but the same server also exposes an
      // OpenAI-compatible surface at /v1 — which is the surface a dictation or
      // image request actually lands on, because both builders append the
      // conventional OpenAI path to the connection's base URL.
      assert.equal(def.chatPath, '/api/chat');
      assert.equal(def.streamFormat, 'ndjson');
      continue;
    }
    // Every other listed connection addresses chat at /chat/completions.
    // Gemini's per-model /v1beta/models/{model}:generateContent and Anthropic's
    // /v1/messages are the two shapes that are not this.
    assert.equal(def.chatPath, '/chat/completions', id + ' does not chat at /chat/completions');
  }
});

check('the providers with their own wire shape are not listed', () => {
  assert.equal(shapes.isOpenAIShaped('gemini'), false, 'Gemini speaks generateContent');
  assert.equal(shapes.isOpenAIShaped('anthropic'), false, 'Anthropic speaks the Messages API');
});

check('an unknown or absent provider is not OpenAI-shaped', () => {
  assert.equal(shapes.isOpenAIShaped('custom-gateway'), false);
  assert.equal(shapes.isOpenAIShaped(''), false);
  assert.equal(shapes.isOpenAIShaped(null), false);
  assert.equal(shapes.isOpenAIShaped(undefined), false);
  assert.equal(shapes.isOpenAIShaped(42), false);
});

check('the list is frozen so a consumer cannot mutate the shared answer', () => {
  assert.ok(Object.isFrozen(shapes.OPENAI_SHAPED_PROVIDERS));
  assert.throws(() => { shapes.OPENAI_SHAPED_PROVIDERS.push('anthropic'); }, TypeError);
});

check('the dictation module reads the one shared list', () => {
  // The list has exactly one consumer left (dictation), and it must still
  // resolve against this module rather than a private copy.
  const transcribe = require(path.resolve(__dirname, '..', 'src', 'transcribe.js'));
  assert.equal(transcribe.audioChatModel({ id: 'claude-sonnet-5', provider: 'anthropic', inputModalities: ['audio'] }), false);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
