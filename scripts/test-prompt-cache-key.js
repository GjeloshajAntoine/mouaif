'use strict';

// Test: OpenAI-family prompt-cache routing key.
//
// OpenAI-family endpoints cache prompt prefixes automatically, but they only
// serve a warm cache when consecutive requests of one conversation reach the
// same machine. `prompt_cache_key` is the documented routing hint for that,
// and mouaif was not sending it at all — so long chats spread across machines
// paid the full input rate on every turn even though the provider was
// reporting `prompt_tokens_details.cached_tokens` as zero.
//
// The contract verified here:
//   - present for the providers whose upstream accepts the field,
//   - absent everywhere else (a strict gateway 400s on unknown body fields,
//     and Anthropic uses explicit `cache_control` breakpoints instead),
//   - byte-identical across the requests of one chat and different between
//     chats (that is the whole point of the hint),
//   - omitted when there is no chat, and
//   - inert for the legacy 3-argument builder call older tests rely on.

const path = require('path');
const { BUILDERS } = require(path.resolve(__dirname, '..', 'src', 'ai-endpoints.js'));
const { promptCacheKeyFor } = require(path.resolve(__dirname, '..', 'src', 'ai-stream.js'));

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('PASS  ' + label); }
  else { failed++; console.log('FAIL  ' + label); }
}

const MSG = [{ role: 'user', content: 'hi' }];
function model(provider, extra) {
  return Object.assign(
    { id: 'gpt-4o', provider, apiKey: 'k', baseUrl: 'https://api.openai.com/v1' },
    extra || {}
  );
}
const KEY = 'mouaif-chat-1';

// --- 1. Derivation from the chat id ------------------------------------
{
  ok(promptCacheKeyFor(null) === null, 'key: no opts -> null');
  ok(promptCacheKeyFor({}) === null, 'key: no chatId -> null');
  ok(promptCacheKeyFor({ chatId: '' }) === null, 'key: empty chatId -> null');
  ok(promptCacheKeyFor({ chatId: 'xyz' }) === 'mouaif-xyz', 'key: derived from chatId');
  ok(
    promptCacheKeyFor({ chatId: 'xyz' }) === promptCacheKeyFor({ chatId: 'xyz' }),
    'key: stable for the same chat'
  );
  ok(
    promptCacheKeyFor({ chatId: 'a' }) !== promptCacheKeyFor({ chatId: 'b' }),
    'key: distinct between chats'
  );
  const long = promptCacheKeyFor({ chatId: 'a'.repeat(200) });
  ok(long.length === 64, 'key: capped at 64 chars, got ' + long.length);
}

// --- 2. Providers that accept the field --------------------------------
for (const provider of ['openai-compatible', 'openrouter', 'azure']) {
  const req = BUILDERS[provider](model(provider), MSG, true, undefined, { promptCacheKey: KEY });
  ok(req.body.prompt_cache_key === KEY, provider + ': sends prompt_cache_key');
}

// --- 3. Providers that must never see it -------------------------------
// github-copilot is OpenAI-shaped but rides a gateway of its own, and the
// remaining providers are non-OpenAI upstreams. Anthropic marks its cached
// prefix with cache_control instead, so the field would be meaningless there.
for (const provider of ['github-copilot', 'mistral', 'groq', 'deepseek']) {
  const req = BUILDERS[provider](model(provider), MSG, true, undefined, { promptCacheKey: KEY });
  ok(!('prompt_cache_key' in req.body), provider + ': omits prompt_cache_key');
}
{
  const req = BUILDERS.anthropic(
    { id: 'claude-sonnet-4', provider: 'anthropic', apiKey: 'k' },
    MSG, true, []
  );
  ok(!('prompt_cache_key' in req.body), 'anthropic: omits prompt_cache_key');
}

// --- 4. No chat -> no field, and legacy calls stay inert ---------------
{
  const noChat = BUILDERS['openai-compatible'](
    model('openai-compatible'), MSG, true, undefined, { promptCacheKey: null });
  ok(!('prompt_cache_key' in noChat.body), 'no chat id: omits prompt_cache_key');

  const noOpts = BUILDERS['openai-compatible'](
    model('openai-compatible'), MSG, true, undefined, {});
  ok(!('prompt_cache_key' in noOpts.body), 'empty request opts: omits prompt_cache_key');

  const legacy = BUILDERS['openai-compatible'](model('openai-compatible'), MSG, true);
  ok(!('prompt_cache_key' in legacy.body), 'legacy 3-argument call: omits prompt_cache_key');
}

// --- 5. Byte-stable across the turns of one conversation ---------------
// This is what makes the hint work: every tool round and every follow-up
// turn must reuse the exact same key, or the upstream sees an unrelated
// conversation each time and never serves the warm cache.
{
  const first = BUILDERS['openai-compatible'](
    model('openai-compatible'), MSG, true, undefined, { promptCacheKey: KEY });
  const second = BUILDERS['openai-compatible'](
    model('openai-compatible'),
    MSG.concat([{ role: 'assistant', content: 'x' }, { role: 'user', content: 'again' }]),
    true, undefined, { promptCacheKey: KEY });
  const other = BUILDERS['openai-compatible'](
    model('openai-compatible'), MSG, true, undefined, { promptCacheKey: 'mouaif-chat-2' });
  ok(first.body.prompt_cache_key === second.body.prompt_cache_key,
    'same chat: key is byte-stable across turns');
  ok(first.body.prompt_cache_key !== other.body.prompt_cache_key,
    'different chats: keys differ');
}

console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
process.exit(failed ? 1 : 0);
