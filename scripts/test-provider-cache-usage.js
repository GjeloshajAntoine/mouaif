'use strict';

// Verify cached-input usage normalization for providers that include cached
// tokens inside their total prompt count.
const { PARSERS } = require('../src/ai.js');

let failed = 0;
function check(name, condition, detail) {
  if (condition) console.log('PASS  ' + name);
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

function events(parser, data) {
  return Array.from(parser('message', JSON.stringify(data)));
}

{
  const parsed = events(PARSERS['openai-compatible'], {
    choices: [],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800 }
    }
  });
  const usage = parsed.find((event) => event.name === 'done').data.usage;
  check('OpenAI: prompt total preserved', usage.promptTokens === 1000, JSON.stringify(usage));
  check('OpenAI: cached prompt subset normalized', usage.cacheReadTokens === 800, JSON.stringify(usage));
}

{
  const parsed = events(PARSERS.deepseek, {
    choices: [],
    usage: {
      prompt_tokens: 2000,
      completion_tokens: 150,
      prompt_cache_hit_tokens: 1800,
      prompt_cache_miss_tokens: 200
    }
  });
  const usage = parsed.find((event) => event.name === 'done').data.usage;
  check('DeepSeek: prompt total preserved', usage.promptTokens === 2000, JSON.stringify(usage));
  check('DeepSeek: prompt_cache_hit_tokens normalized', usage.cacheReadTokens === 1800, JSON.stringify(usage));
}
{
  const parsed = events(PARSERS.openrouter, {
    choices: [],
    usage: {
      promptTokens: 900,
      completionTokens: 40,
      promptTokensDetails: { cachedTokens: 700 }
    }
  });
  const usage = parsed.find((event) => event.name === 'done').data.usage;
  check('OpenRouter: camelCase cached subset normalized', usage.cacheReadTokens === 700, JSON.stringify(usage));
}

{
  const parsed = events(PARSERS.gemini, {
    candidates: [],
    usageMetadata: {
      promptTokenCount: 1200,
      candidatesTokenCount: 60,
      cachedContentTokenCount: 1000
    }
  });
  const usage = parsed.find((event) => event.name === 'done').data.usage;
  check('Gemini: prompt total preserved', usage.promptTokens === 1200, JSON.stringify(usage));
  check('Gemini: cached content subset normalized', usage.cacheReadTokens === 1000, JSON.stringify(usage));
}

console.log('--- ' + (7 - failed) + ' passed, ' + failed + ' failed ---');
process.exit(failed ? 1 : 0);
