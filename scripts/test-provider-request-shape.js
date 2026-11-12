'use strict';

// Regression test for three request-shape defects in the provider builders
// and the delegated-cost accumulator.
//
//  1. Anthropic thinking budget. `budget_tokens` was clamped to 100000 but
//     `max_tokens` was derived from the *uncapped* value, so a project
//     thinking level of "200000" asked for budget_tokens: 100000 next to
//     max_tokens: 200256 — an inconsistent request that Anthropic rejects.
//
//  2. Gemini and Ollama system messages. Both joined `m.content` directly,
//     which turns the block array the subagent runner pushes
//     (`[{ type: 'text', text }]`) into the string "[object Object]", so a
//     delegated run reached the provider with no system instruction at all.
//
//  3. Delegated cost. `Number(result && result.totalCost)` is 0 for a
//     missing value, so a subagent whose cost could not be determined was
//     recorded as an exact $0 and the run's "every part is known" guard
//     reported a total that understated the real spend.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-builders-home-'));
process.env.MOUAIF_HOME = home;

const { BUILDERS, PARSERS } = require('../src/ai-endpoints.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

const BLOCKS = [{ type: 'text', text: 'You are a focused subagent.' }];

function main() {
  // ---- 1. Anthropic thinking budget -------------------------------
  {
    // No explicit max_tokens: the fallback is derived from the budget, and
    // it must be derived from the *capped* budget.
    const req = BUILDERS.anthropic(
      { id: 'claude-sonnet-4', thinkingLevel: '200000' },
      [{ role: 'user', content: 'hi' }],
      true
    );
    const body = req.body;
    // Sonnet 4 writes at most 64000 tokens: the budget leaves 4096 of them
    // for the answer, and max_tokens never passes the model's ceiling.
    check('anthropic caps the thinking budget', body.thinking && body.thinking.budget_tokens === 59904,
      JSON.stringify(body.thinking));
    check('anthropic keeps max_tokens within the model ceiling',
      body.max_tokens === 64000, 'max_tokens=' + body.max_tokens);
    check('anthropic keeps answer room above the budget',
      body.max_tokens >= body.thinking.budget_tokens + 4096);

    // An explicit, larger max_tokens is preserved.
    const explicit = BUILDERS.anthropic(
      { id: 'claude-sonnet-4', maxOutputTokens: '200000', thinkingLevel: '200000' },
      [{ role: 'user', content: 'hi' }],
      true
    );
    check('an explicit larger max_tokens is kept',
      explicit.body.max_tokens === 200000 && explicit.body.thinking.budget_tokens === 59904,
      JSON.stringify({ max_tokens: explicit.body.max_tokens, thinking: explicit.body.thinking }));

    const small = BUILDERS.anthropic(
      { id: 'claude-sonnet-4', thinkingLevel: 'low' },
      [{ role: 'user', content: 'hi' }],
      true
    );
    check('a preset budget is used as-is',
      small.body.thinking && small.body.thinking.budget_tokens === 2048,
      JSON.stringify(small.body.thinking));
    check('max_tokens leaves room for the answer after the preset budget', small.body.max_tokens >= 2048 + 4096,
      'max_tokens=' + small.body.max_tokens);

    // Without a cap, a streamed request asks for the model's room rather
    // than the old 1024-token default that cut replies short.
    const plain = BUILDERS.anthropic({ id: 'claude-sonnet-4-5' }, [{ role: 'user', content: 'hi' }], true);
    check('default max_tokens is the streaming default', plain.body.max_tokens === 64000, 'max_tokens=' + plain.body.max_tokens);
    const legacy = BUILDERS.anthropic({ id: 'claude-3-5-haiku-20241022' }, [{ role: 'user', content: 'hi' }], true);
    check('default max_tokens respects an older model ceiling', legacy.body.max_tokens === 8192, 'max_tokens=' + legacy.body.max_tokens);

    // Current models take adaptive thinking with an effort level; a raw
    // budget is rejected by the API on Opus 4.7+ and every Claude 5 model.
    for (const id of ['claude-sonnet-5', 'claude-opus-4-7', 'claude-opus-5-5', 'claude-fable-5-2']) {
      const adaptive = BUILDERS.anthropic({ id, thinkingLevel: 'high' }, [{ role: 'user', content: 'hi' }], true).body;
      check(id + ' uses adaptive thinking',
        adaptive.thinking && adaptive.thinking.type === 'adaptive' && !('budget_tokens' in adaptive.thinking)
          && adaptive.output_config && adaptive.output_config.effort === 'high',
        JSON.stringify({ thinking: adaptive.thinking, output_config: adaptive.output_config }));
    }
    const fromBudget = BUILDERS.anthropic({ id: 'claude-sonnet-5', thinkingLevel: '8192' }, [{ role: 'user', content: 'hi' }], true).body;
    check('a stored token budget maps to an effort on adaptive models',
      fromBudget.output_config && fromBudget.output_config.effort === 'medium', JSON.stringify(fromBudget.output_config));
    const opus46 = BUILDERS.anthropic({ id: 'claude-opus-4-6', thinkingLevel: 'xhigh' }, [{ role: 'user', content: 'hi' }], true).body;
    check('an effort the model lacks steps down', opus46.output_config && opus46.output_config.effort === 'high',
      JSON.stringify(opus46.output_config));

    // Every tool_result of a round rides one user message.
    const merged = BUILDERS.anthropic({ id: 'claude-sonnet-4-5' }, [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 't2', type: 'function', function: { name: 'b', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'one' },
      { role: 'tool', tool_call_id: 't2', content: 'two' }
    ], true).body;
    const last = merged.messages[merged.messages.length - 1];
    check('tool results of one round share a user message',
      merged.messages.length === 3 && last.role === 'user' && last.content.filter((b) => b.type === 'tool_result').length === 2,
      JSON.stringify(merged.messages.map((m) => m.role)));

    // A tool round replays its thinking blocks (with signatures) unchanged,
    // ahead of the tool_use they produced.
    const replay = BUILDERS.anthropic({ id: 'claude-sonnet-5', thinkingLevel: 'low' }, [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'checking', tool_calls: [{ id: 'x_t1', type: 'function', function: { name: 'a', arguments: '{"k":1}' } }],
        anthropicBlocks: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'text', text: 'checking' }, { type: 'tool_use' }] },
      { role: 'tool', tool_call_id: 'x_t1', content: 'ok' }
    ], true).body;
    const assistant = replay.messages[1].content.map((b) => b.type + (b.signature ? ':' + b.signature : '') + (b.id ? ':' + b.id : ''));
    check('thinking blocks are replayed in a tool round',
      JSON.stringify(assistant) === JSON.stringify(['thinking:sig', 'text', 'tool_use:x_t1']), JSON.stringify(assistant));
  }

  // ---- 1b. Anthropic stream: stop reasons and ordered blocks ------
  {
    const acc = new Map();
    const evs = [];
    const feed = (obj) => { for (const ev of PARSERS.anthropic('', JSON.stringify(obj), acc)) evs.push(ev); };
    feed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } });
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } });
    feed({ type: 'content_block_stop', index: 0 });
    feed({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    feed({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } });
    feed({ type: 'content_block_stop', index: 1 });
    feed({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } });
    const blocks = evs.filter((e) => e.name === 'assistant_block').map((e) => e.data);
    check('the parser records the signed thinking block',
      blocks[0] && blocks[0].type === 'thinking' && blocks[0].thinking === 'plan' && blocks[0].signature === 'abc', JSON.stringify(blocks));
    check('the parser records the text block after it', blocks[1] && blocks[1].type === 'text' && blocks[1].text === 'Hi');
    const finish = evs.find((e) => e.name === 'finish');
    check('stop_reason max_tokens surfaces as finish', finish && finish.data.reason === 'max_tokens', JSON.stringify(finish));
  }
  {
    const none = BUILDERS.anthropic({ id: 'claude-sonnet-4' }, [{ role: 'user', content: 'hi' }], true);
    check('no thinking level sends no thinking block', none.body.thinking === undefined);
  }

  // ---- 2. Gemini / Ollama system content --------------------------
  {
    const gemini = BUILDERS.gemini(
      { id: 'gemini-2.5-pro' },
      [{ role: 'system', content: BLOCKS }, { role: 'user', content: 'hi' }],
      true
    );
    const text = gemini.body.systemInstruction && gemini.body.systemInstruction.parts[0].text;
    check('gemini flattens a block-array system message',
      text === 'You are a focused subagent.', JSON.stringify(text));
    check('gemini never sends "[object Object]"',
      !JSON.stringify(gemini.body).includes('[object Object]'));
    check('gemini still accepts a plain-string system message', (() => {
      const r = BUILDERS.gemini({ id: 'gemini-2.5-pro' }, [{ role: 'system', content: 'plain' }], true);
      return r.body.systemInstruction.parts[0].text === 'plain';
    })());

    const ollama = BUILDERS.ollama(
      { id: 'llama3' },
      [{ role: 'system', content: BLOCKS }, { role: 'user', content: 'hi' }],
      true
    );
    check('ollama flattens a block-array system message',
      ollama.body.messages[0].content === 'You are a focused subagent.',
      JSON.stringify(ollama.body.messages[0].content));
    check('ollama leaves string content untouched',
      ollama.body.messages[1].content === 'hi');
    check('ollama sends no "[object Object]"',
      !JSON.stringify(ollama.body).includes('[object Object]'));
  }
}

// ---- 3. Delegated cost --------------------------------------------
//
// delegatedCostForResult() is a closure inside streamChat, so the module
// source is executed in a VM and the helper is pulled out of the parse
// scope the same way scripts/test-chat-stream-abort.js extracts send().
function delegatedCostChecks() {
  const source = fs.readFileSync(path.join(__dirname, '../src/ai-stream.js'), 'utf8');
  const start = source.indexOf('function delegatedCostForResult(');
  assert.ok(start > 0, 'delegatedCostForResult must still exist');
  // End of the helper: the next 2-space-indented member function of
  // streamChat. Deliberately not tied to a particular neighbour's name so
  // renaming a sibling helper does not break this extraction.
  const end = source.indexOf('\n  function ', start);
  assert.ok(end > start, 'delegatedCostForResult must be followed by another streamChat helper');
  const chunk = source.slice(start, end);

  const context = vm.createContext(new Proxy({
    Number, isFinite, Object, Array, Math,
    usageMetrics: { computeCost: () => ({ known: false, total: 0 }) },
    opts: {},
    require: () => ({ getApp: () => ({}) })
  }, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(chunk + '; this.delegatedCostForResult = delegatedCostForResult;', context);
  const fn = context.delegatedCostForResult;

  check('a numeric totalCost is used as-is', fn({ totalCost: 0.004 }) === 0.004);
  check('a genuine zero cost stays zero', fn({ totalCost: 0 }) === 0);
  check('a null totalCost is unknown, not zero', fn({ totalCost: null }) === null,
    JSON.stringify(fn({ totalCost: null })));
  check('a missing totalCost falls through', fn({ providerCost: 0.002 }) === 0.002);
  check('a null providerCost is unknown too', fn({ providerCost: null, totalCost: null }) === null);
  check('an empty result is unknown', fn({}) === null);
  check('a negative totalCost is rejected', fn({ totalCost: -1 }) === null,
    JSON.stringify(fn({ totalCost: -1 })));
  check('a numeric string is accepted', fn({ totalCost: '0.003' }) === 0.003);
}

try {
  main();
  delegatedCostChecks();
} catch (e) {
  console.error(e);
  failed++;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
if (failed) process.exitCode = 1;
