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

const { BUILDERS } = require('../src/ai-endpoints.js');

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
    check('anthropic caps the thinking budget', body.thinking && body.thinking.budget_tokens === 100000,
      JSON.stringify(body.thinking));
    check('anthropic derives max_tokens from the capped budget',
      body.max_tokens === 100256, 'max_tokens=' + body.max_tokens);
    check('anthropic keeps max_tokens above the budget',
      body.max_tokens >= body.thinking.budget_tokens + 256);

    // An explicit, larger max_tokens is preserved.
    const explicit = BUILDERS.anthropic(
      { id: 'claude-sonnet-4', maxOutputTokens: '200000', thinkingLevel: '200000' },
      [{ role: 'user', content: 'hi' }],
      true
    );
    check('an explicit larger max_tokens is kept',
      explicit.body.max_tokens === 200000 && explicit.body.thinking.budget_tokens === 100000,
      JSON.stringify({ max_tokens: explicit.body.max_tokens, thinking: explicit.body.thinking }));

    const small = BUILDERS.anthropic(
      { id: 'claude-sonnet-4', thinkingLevel: 'low' },
      [{ role: 'user', content: 'hi' }],
      true
    );
    check('a preset budget is used as-is',
      small.body.thinking && small.body.thinking.budget_tokens === 2048,
      JSON.stringify(small.body.thinking));
    check('max_tokens clears the preset budget too', small.body.max_tokens === 2304,
      'max_tokens=' + small.body.max_tokens);

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
  const end = source.indexOf('function addDelegatedUsage(', start);
  assert.ok(end > start, 'addDelegatedUsage must follow it');
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
