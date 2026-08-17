'use strict';

// Test: Claude routed through OpenRouter carries Anthropic prompt-cache
// breakpoints. OpenRouter forwards Anthropic prompt caching only when the
// OpenAI-shaped request has explicit `cache_control` markers on message
// content blocks; the vanilla OpenAI body has none, so this verifies
// buildOpenAIRequest injects them for `anthropic/*` OpenRouter models
// (and leaves every other OpenAI-shaped provider untouched).

const path = require('path');
const { BUILDERS } = require(path.resolve(__dirname, '..', 'src', 'ai-endpoints.js'));

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('PASS  ' + label); }
  else { failed++; console.log('FAIL  ' + label); }
}

const OR_CLAUDE = { id: 'anthropic/claude-sonnet-4.5', provider: 'openrouter', apiKey: 'sk-or-test' };
const OR_LLAMA = { id: 'meta-llama/llama-3.1-70b-instruct', provider: 'openrouter', apiKey: 'sk-or-test' };
const OPENAI = { id: 'gpt-4o', provider: 'openai-compatible', apiKey: 'sk-test' };

function lastPartCache(msg) {
  if (!msg || !Array.isArray(msg.content) || !msg.content.length) return null;
  const p = msg.content[msg.content.length - 1];
  return p && p.cache_control ? p.cache_control : null;
}

// --- OpenRouter Claude: multi-message conversation ---------------------
{
  const messages = [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' }
  ];
  const req = BUILDERS.openrouter(OR_CLAUDE, messages, true);
  const sent = req.body.messages;

  ok(lastPartCache(sent[0]) && lastPartCache(sent[0]).type === 'ephemeral',
    'openrouter claude: system message carries cache_control');
  // Penultimate is the assistant "first answer" (index 2).
  ok(lastPartCache(sent[2]) && lastPartCache(sent[2]).type === 'ephemeral',
    'openrouter claude: penultimate message carries cache_control');
  // Final message must never be marked.
  ok(lastPartCache(sent[3]) == null,
    'openrouter claude: final message not marked');
  // Input array not mutated.
  ok(typeof messages[0].content === 'string',
    'openrouter claude: original messages array untouched');
}

// --- OpenRouter Claude: single user message (first turn) ---------------
{
  const messages = [{ role: 'user', content: 'hello' }];
  const req = BUILDERS.openrouter(OR_CLAUDE, messages, true);
  const sent = req.body.messages;
  // No system, only one message -> penultimate does not exist; nothing to cache.
  ok(lastPartCache(sent[0]) == null,
    'openrouter claude: single message has no breakpoint');
}

// --- OpenRouter Claude: system + one user message ----------------------
{
  const messages = [
    { role: 'system', content: 'sys prefix' },
    { role: 'user', content: 'hi' }
  ];
  const req = BUILDERS.openrouter(OR_CLAUDE, messages, true);
  const sent = req.body.messages;
  ok(lastPartCache(sent[0]) && lastPartCache(sent[0]).type === 'ephemeral',
    'openrouter claude: system marked as both system and penultimate');
}

// --- Non-Claude OpenRouter model is untouched --------------------------
{
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' }
  ];
  const req = BUILDERS.openrouter(OR_LLAMA, messages, true);
  const sent = req.body.messages;
  ok(typeof sent[0].content === 'string' && typeof sent[2].content === 'string',
    'openrouter non-claude: messages left as plain strings (no markers)');
}

// --- Plain OpenAI provider is untouched --------------------------------
{
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' }
  ];
  const req = BUILDERS['openai-compatible'](OPENAI, messages, true);
  const sent = req.body.messages;
  ok(typeof sent[0].content === 'string' && typeof sent[2].content === 'string',
    'openai-compatible: messages left as plain strings (no markers)');
}

// --- Array-content message keeps its parts, marks the last one ---------
{
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] },
    { role: 'user', content: 'final' }
  ];
  const req = BUILDERS.openrouter(OR_CLAUDE, messages, true);
  const sent = req.body.messages;
  const penult = sent[1];
  ok(Array.isArray(penult.content) && penult.content.length === 2,
    'openrouter claude: array-content parts preserved');
  ok(penult.content[1].cache_control && !penult.content[0].cache_control,
    'openrouter claude: only the last content part is marked');
}

console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
process.exit(failed ? 1 : 0);
