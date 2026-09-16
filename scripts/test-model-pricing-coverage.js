'use strict';

// Every model id we *offer* should also be priceable.
//
// The cost line resolves through model `pricing` → app `modelPricing` → the
// built-in table in src/usage.js → `--`. The middle of that chain is the
// user's, but a gap in the last one is ours: when src/ai-endpoints.js ships a
// curated catalog entry (Anthropic and GitHub Copilot have no public
// list-models endpoint, so their catalogs are hand-maintained) the user can
// pick that model from the picker and then watch the cost line read `--` for
// a model whose price is public.
//
// That had happened: `claude-sonnet-5`, `claude-opus-4.5` and both dated
// Claude 3.5 snapshots were offered with no built-in price. Nothing failed,
// because an unpriced model is a legitimate state (a self-hosted endpoint we
// cannot know). The difference between "we cannot know" and "we forgot" is
// whether the id is in a catalog we wrote, which is exactly what this test
// checks.

const assert = require('node:assert/strict');
const path = require('node:path');

const usage = require(path.resolve(__dirname, '..', 'src', 'usage.js'));
const endpoints = require(path.resolve(__dirname, '..', 'src', 'ai-endpoints.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   - ' + name); }
  catch (err) { fail++; console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]); }
}

// The curated catalogs this repo owns. OpenRouter and the OpenAI-shaped
// providers report their own catalog *and* their own price per row, so they
// are not in scope here — a live price always wins over the built-in table.
const CURATED = {
  anthropic: endpoints.ANTHROPIC_MODEL_CATALOG,
  'github-copilot': endpoints.COPILOT_MODEL_CATALOG
};

check('the curated catalogs are exported and non-empty', () => {
  for (const [provider, catalog] of Object.entries(CURATED)) {
    assert.ok(Array.isArray(catalog) && catalog.length, provider + ' catalog is missing or empty');
    for (const row of catalog) assert.ok(row && row.id, provider + ' has a catalog row with no id');
  }
});

check('every curated catalog model id has a built-in price', () => {
  const missing = [];
  for (const [provider, catalog] of Object.entries(CURATED)) {
    for (const row of catalog) {
      if (!usage.builtinPricingForId(row.id)) missing.push(provider + ':' + row.id);
    }
  }
  assert.deepEqual(missing, [],
    'these offered models would render `--` as their cost: ' + missing.join(', ') +
    ' — add each to BUILTIN_PRICING in src/usage.js, or say in that file why not');
});

check('the price it finds is a real, positive number pair', () => {
  for (const [provider, catalog] of Object.entries(CURATED)) {
    for (const row of catalog) {
      const p = usage.builtinPricingForId(row.id);
      assert.ok(p, provider + ':' + row.id + ' is unpriced');
      for (const k of ['inputPer1K', 'outputPer1K']) {
        assert.equal(typeof p[k], 'number', provider + ':' + row.id + ' ' + k + ' is not a number');
        assert.ok(isFinite(p[k]) && p[k] > 0, provider + ':' + row.id + ' ' + k + ' is not positive');
      }
    }
  }
});

check('an OpenRouter vendor prefix resolves to the same price as the bare id', () => {
  // The catalog these ids come from is vendor-prefixed (`anthropic/claude-sonnet-5`).
  // builtinPricingForId strips the prefix, so the two spellings must agree —
  // otherwise a project could be priced differently for the same model
  // depending on which provider it was configured against.
  for (const [provider, catalog] of Object.entries(CURATED)) {
    for (const row of catalog) {
      const bare = usage.builtinPricingForId(row.id);
      const prefixed = usage.builtinPricingForId('anthropic/' + row.id);
      assert.deepEqual(prefixed, bare, row.id + ' differs between the bare and vendor-prefixed spelling');
    }
  }
});

check('the newly priced Claude models resolve through the documented chain', () => {
  // A spot-check that the numbers landed where resolvePricing looks.
  const viaBuiltin = usage.resolvePricing({ id: 'claude-sonnet-5' }, null);
  assert.equal(viaBuiltin.source, 'builtin');
  assert.equal(viaBuiltin.inputPer1K, 0.002);
  assert.equal(viaBuiltin.outputPer1K, 0.01);
  // A per-model override still wins over the built-in table.
  const viaModel = usage.resolvePricing(
    { id: 'claude-sonnet-5', pricing: { inputPer1K: 1, outputPer1K: 2 } }, null);
  assert.equal(viaModel.source, 'model');
  assert.equal(viaModel.inputPer1K, 1);
});

check('an unknown model is still allowed to be unpriced', () => {
  // The test must not imply every id needs a price: a self-hosted model we
  // have never heard of legitimately renders `--`.
  assert.equal(usage.builtinPricingForId('my-local-llama'), null);
  assert.equal(usage.resolvePricing({ id: 'my-local-llama' }, null), null);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
