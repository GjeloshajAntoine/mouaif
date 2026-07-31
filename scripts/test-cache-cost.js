// Verify the Anthropic prompt-cache-aware cost computation in src/usage.js.
//
// Anthropic bills cached reads at 10% of the input rate and cache writes
// (creation) at 125% of the input rate. computeCost must price the cached
// portion of a turn at those tiers instead of charging the full input rate
// for every prompt token.
'use strict';

const path = require('path');
const usage = require(path.resolve(__dirname, '..', 'src', 'usage.js'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

// claude-sonnet-4: $3/M input, $15/M output (matches src/usage.js builtin).
const model = { id: 'claude-sonnet-4', pricing: { inputPer1K: 0.003, outputPer1K: 0.015 } };

// 1) No cache fields -> identical to the old full-rate pricing.
{
  const c = usage.computeCost({ model, usage: { promptTokens: 1000, completionTokens: 1000 } });
  check('no cache fields: input at full rate (0.003)', near(c.input, 0.003), c.input);
  check('no cache fields: output at full rate (0.015)', near(c.output, 0.015), c.output);
  check('no cache fields: total', near(c.total, 0.018), c.total);
  check('no cache fields: known', c.known === true);
}

// 2) Cached read tokens billed at 10% of input.
{
  const c = usage.computeCost({ model, usage: { promptTokens: 1000, completionTokens: 0, cacheReadTokens: 1000 } });
  check('all-read: input is 10% of full rate (0.0003)', near(c.input, 0.0003), c.input);
  check('all-read: total', near(c.total, 0.0003), c.total);
}

// 3) Mixed: uncached prompt at full rate, reads at 10%, writes at 125%.
//    prompt=1000, read=500, write=200 -> uncached=300.
//    input = 300/1000*0.003 + 500/1000*0.003*0.1 + 200/1000*0.003*1.25
//          = 0.0009 + 0.00015 + 0.00075 = 0.0018
{
  const c = usage.computeCost({ model, usage: { promptTokens: 1000, completionTokens: 1000, cacheReadTokens: 500, cacheCreationTokens: 200 } });
  check('mixed: uncached 300 at full rate', near(c.input, 0.0009 + 0.00015 + 0.00075), c.input);
  check('mixed: output unchanged (0.015)', near(c.output, 0.015), c.output);
  check('mixed: total', near(c.total, 0.0168), c.total);
}

// 4) Cache tokens exceeding reported prompt tokens must not produce
//    negative uncached input (defensive clamp).
{
  const c = usage.computeCost({ model, usage: { promptTokens: 100, completionTokens: 0, cacheReadTokens: 500, cacheCreationTokens: 200 } });
  check('clamp: uncached input never negative', c.input >= 0, c.input);
  check('clamp: known still true', c.known === true);
}

// 5) Unknown model -> known:false regardless of cache fields.
{
  const c = usage.computeCost({ model: { id: 'unknown-model' }, usage: { promptTokens: 100, cacheReadTokens: 50 } });
  check('unknown model: known false', c.known === false);
  check('unknown model: total 0', near(c.total, 0));
}

// 6) Per-model cache factors override the standard 10% / 125% tiers.
//    prompt=1000, read=500, write=200, readFactor=0.2, writeFactor=1.5:
//    input = 300/1000*0.003 + 500/1000*0.003*0.2 + 200/1000*0.003*1.5
//          = 0.0009 + 0.0003 + 0.0009 = 0.0021
{
  const m = { id: 'claude-sonnet-4', pricing: { inputPer1K: 0.003, outputPer1K: 0.015, cacheReadFactor: 0.2, cacheWriteFactor: 1.5 } };
  const c = usage.computeCost({ model: m, usage: { promptTokens: 1000, completionTokens: 0, cacheReadTokens: 500, cacheCreationTokens: 200 } });
  check('custom factors: read priced at 20%', near(c.input, 0.0021), c.input);
  check('custom factors: total', near(c.total, 0.0021), c.total);
  check('custom factors: factor carried by resolvePricing',
    usage.resolvePricing(m, null) && usage.resolvePricing(m, null).cacheReadFactor === 0.2,
    JSON.stringify(usage.resolvePricing(m, null)));
}

// 7) String / garbage factor values fall back to the default.
{
  const m = { id: 'claude-sonnet-4', pricing: { inputPer1K: 0.003, outputPer1K: 0.015, cacheReadFactor: 'garbage', cacheWriteFactor: -3 } };
  const c = usage.computeCost({ model: m, usage: { promptTokens: 1000, completionTokens: 0, cacheReadTokens: 500, cacheCreationTokens: 200 } });
  check('garbage factors: falls back to defaults (0.0018)', near(c.input, 0.0018), c.input);
}

console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
process.exit(failed ? 1 : 0);
