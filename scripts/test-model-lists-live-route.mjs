// /api/ai/models/live still answers correctly after the refactor: the route
// now delegates to src/modelList.js, so this checks the HTTP contract (status
// mapping, cache flag, the _bust bypass) against a mock upstream.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-live-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
const require = createRequire(import.meta.url);
const ai = require('../src/ai.js');

let calls = 0;
ai.listModels = async (provider) => {
  calls++;
  // Keyed on real provider ids: the route rejects an unknown provider before
  // it ever reaches listModels, so a fictional id cannot test the error map.
  if (provider === 'anthropic') { const e = new Error('No API key configured'); e.code = 'ENO_APIKEY'; throw e; }
  if (provider === 'mistral') { const e = new Error('upstream 500'); e.code = 'EUPSTREAM'; e.status = 500; throw e; }
  if (provider === 'groq') { const e = new Error('fetch failed'); e.code = 'EUNREACHABLE'; throw e; }
  return [{ id: 'gpt-4o', label: 'GPT-4o' }];
};
// A purpose other than `transcription` is the chat slice. (`image` was
  // removed with the image-generation feature, so the route no longer
  // accepts it; this stub stays only to prove it is never consulted.)
let imageCalls = 0;
ai.listImageModels = async (provider) => {
  imageCalls++;
  if (provider === 'openrouter') return [{ id: 'openai/gpt-image-2', label: 'GPT Image 2' }];
  return null; // no separate image slice -> caller falls back to the chat list
};

const server = require('../src/index.js').createServer(0);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const get = async (qs) => {
  const r = await fetch(base + '/api/ai/models/live' + qs);
  return { status: r.status, body: await r.json() };
};
try {
  assert.equal((await get('?provider=does-not-exist')).status, 400, 'unknown provider');
  const ok = await get('?provider=openai-compatible');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.models.length, 1);
  assert.equal(ok.body.cached, false, 'the first call is not cached');
  assert.equal(calls, 1);
  const cached = await get('?provider=openai-compatible');
  assert.equal(cached.status, 200);
  assert.equal(calls, 1, 'the second call is served from the cache');
  assert.equal(cached.body.cached, true);
  await get('?provider=openai-compatible&_bust=1');
  assert.equal(calls, 2, '_bust bypasses the cache');
  assert.equal((await get('?provider=anthropic')).status, 400, 'ENO_APIKEY maps to 400');
  const up = await get('?provider=mistral');
  assert.equal(up.status, 500, 'EUPSTREAM keeps the upstream status');
  assert.equal(up.body.upstreamStatus, 500);
  assert.equal((await get('?provider=groq')).status, 503, 'EUNREACHABLE maps to 503');

  // purpose=image was removed with the image-generation feature. The route
  // must reject the unknown purpose by treating it as the chat slice, and it
  // must never reach the image adapter.
  const img = await get('?provider=openrouter&purpose=image');
  assert.equal(img.status, 200, JSON.stringify(img.body));
  assert.equal(imageCalls, 0, 'the removed image purpose never consults listImageModels');

  console.log('PASS /api/ai/models/live: status mapping, cache reuse, _bust bypass, image slice after the modelList extraction');
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
}
