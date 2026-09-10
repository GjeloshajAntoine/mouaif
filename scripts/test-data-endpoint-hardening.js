'use strict';

// Regression test for the legacy REST KV endpoints (GET/POST /data).
//
// POST /data merged the request body straight into the in-memory `store`
// with Object.assign, after a JSON.parse whose only failure mode was a
// syntax error:
//
//   * a non-object body silently "succeeded" (or threw a TypeError that
//     was reported as "Invalid JSON");
//   * a `__proto__` key reached the object's prototype setter;
//   * the body was accumulated with no size limit, so any client could
//     grow the process heap by posting a large payload.
//
// The endpoints stay reachable without an Origin header (plain CLI
// clients), which is the shape the test drives.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-data-endpoint-'));
process.env.MOUAIF_HOME = home;

const { createServer } = require('../src/index.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

async function main() {
  const server = createServer(0, {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;

  const post = (body, headers) => fetch(origin + '/data', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body
  });
  const getData = async () => (await fetch(origin + '/data')).json();

  try {
    check('GET /data serves the store', (await getData()).message === 'Hello from mouaif!');

    // A plain object still merges.
    const ok = await post(JSON.stringify({ message: 'updated', extra: 42 }));
    check('a JSON object is still merged', ok.status === 200, 'status=' + ok.status);
    const merged = await getData();
    check('the merged values are stored', merged.message === 'updated' && merged.extra === 42,
      JSON.stringify(merged));
    check('the server still stamps the timestamp', typeof merged.timestamp === 'string');

    // Non-object bodies are refused.
    for (const [label, body] of [
      ['an array', '[1,2,3]'],
      ['a string', '"just text"'],
      ['a number', '7'],
      ['null', 'null']
    ]) {
      const res = await post(body);
      check(`${label} is rejected`, res.status === 400, 'status=' + res.status);
    }

    const malformed = await post('{not json');
    check('malformed JSON is still a 400', malformed.status === 400, 'status=' + malformed.status);

    // Prototype pollution is dropped while the rest of the payload applies.
    const polluted = await post('{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":{"y":2},"safe":"yes"}');
    check('a __proto__ payload is accepted but sanitized', polluted.status === 200, 'status=' + polluted.status);
    const after = await getData();
    check('the object prototype is untouched', ({}).polluted === undefined && after.polluted === undefined);
    check('__proto__ was not stored as a key', !Object.prototype.hasOwnProperty.call(after, '__proto__'));
    check('constructor/prototype were dropped',
      !Object.prototype.hasOwnProperty.call(after, 'constructor')
      && !Object.prototype.hasOwnProperty.call(after, 'prototype'));
    check('the rest of the payload still applied', after.safe === 'yes', JSON.stringify(after));

    // Oversized bodies are refused before they are parsed.
    const big = JSON.stringify({ blob: 'x'.repeat(300 * 1024) });
    const tooLarge = await post(big);
    check('an oversized body is a 413', tooLarge.status === 413, 'status=' + tooLarge.status);
    const body = await tooLarge.json();
    check('the rejection names the cap', body.code === 'ETOOLARGE' && body.maxBytes === 256 * 1024,
      JSON.stringify(body));
    const afterBig = await getData();
    check('the oversized payload was not merged', afterBig.blob === undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { require('../src/settings.js').close(); } catch { /* already closed */ }
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
