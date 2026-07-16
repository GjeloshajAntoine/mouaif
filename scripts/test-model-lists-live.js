'use strict';

// Smoke test for the live /api/ai/models/live HTTP route. Requires a
// running mouaif server on 127.0.0.1:5732 (booted separately). Verifies
// the route surface (200 on the curated Copilot path, 400 on unknown
// provider, 502 with code EUPSTREAM on a missing-key Gemini call,
// cached:true on a second call) without assuming any real network
// calls succeed. The per-provider parser tests live in
// scripts/test-model-lists.js.

const http = require('http');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 5732, path: urlPath }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    }).on('error', reject);
  });
}

async function main() {
  // 1) Unknown provider -> 400.
  const r400 = await get('/api/ai/models/live?provider=does-not-exist');
  check('unknown provider -> 400', r400.status === 400);
  check('unknown provider -> { error, provider }', r400.body && r400.body.error && r400.body.provider === 'does-not-exist');

  // 2) GitHub Copilot: curated catalog, no fetch, 200 + non-empty.
  const cop = await get('/api/ai/models/live?provider=github-copilot');
  check('copilot: 200', cop.status === 200);
  check('copilot: models array', Array.isArray(cop.body && cop.body.models));
  check('copilot: at least 5 entries', (cop.body.models || []).length >= 5,
    'got: ' + (cop.body.models || []).length);
  check('copilot: gpt-4o present',
    (cop.body.models || []).some((m) => m.id === 'gpt-4o'));
  check('copilot: returns fetchedAt + cached',
    typeof cop.body.fetchedAt === 'number' && typeof cop.body.cached === 'boolean');

  // 3) Second Copilot call should be cached: true (no upstream call
  //    either way for Copilot, but the cache key is set on the first
  //    read so the flag flips).
  const cop2 = await get('/api/ai/models/live?provider=github-copilot');
  check('copilot second call: cached true', cop2.body && cop2.body.cached === true,
    'body=' + JSON.stringify(cop2.body).slice(0, 120));

  // 4) Gemini: no key in this test env -> 400 ENO_APIKEY (a missing
  //    key is a client config issue, not an upstream 502). The
  //    server detects "no cred" + 401/403 from the upstream and
  //    surfaces a typed error so the chat UI can show "add API key
  //    in Settings → Providers" instead of a generic 502.
  const gem = await get('/api/ai/models/live?provider=gemini');
  check('gemini (no key): 400', gem.status === 400,
    'body=' + JSON.stringify(gem.body).slice(0, 200));
  check('gemini (no key): code ENO_APIKEY', gem.body && gem.body.code === 'ENO_APIKEY',
    'body=' + JSON.stringify(gem.body).slice(0, 200));
  check('gemini (no key): provider echoed', gem.body && gem.body.provider === 'gemini',
    'body=' + JSON.stringify(gem.body).slice(0, 200));

  // 4b) Ollama not running -> 503 EUNREACHABLE (local server down,
  //     not a bad gateway). The 503 vs 502 distinction is what the
  //     chat UI branches on.
  const oll = await get('/api/ai/models/live?provider=ollama');
  check('ollama (not running): 503', oll.status === 503,
    'body=' + JSON.stringify(oll.body).slice(0, 200));
  check('ollama (not running): code EUNREACHABLE', oll.body && oll.body.code === 'EUNREACHABLE',
    'body=' + JSON.stringify(oll.body).slice(0, 200));

  // 5) OpenRouter: 200 + data list (no key needed for the public list).
  const ort = await get('/api/ai/models/live?provider=openrouter');
  check('openrouter: 200', ort.status === 200);
  check('openrouter: models array, many entries',
    Array.isArray(ort.body && ort.body.models) && ort.body.models.length > 50,
    'got: ' + ((ort.body && ort.body.models || []).length));
  check('openrouter: at least one model with provider-shaped id',
    (ort.body.models || []).some((m) => /^[a-z0-9-]+\/[a-z0-9.-]+/i.test(m.id)));

  console.log('---');
  console.log('passed: ' + passed);
  console.log('failed: ' + failed);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
