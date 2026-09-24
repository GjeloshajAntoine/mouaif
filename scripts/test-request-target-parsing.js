'use strict';

// Regression test for the deprecated `url.parse()` request-target parser.
//
// `dispatchRequest` used to split `req.url` with `url.parse(req.url, true)`,
// which Node deprecates (DEP0169) and warns about on the first request of
// every `mouaif serve`:
//
//   [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized
//   and prone to errors that have security implications.
//
// The replacement is `parseRequestTarget()` in src/util.js. Two things have
// to hold, and this test pins both:
//
//   1. PARITY. Every request the dispatcher serves must be split exactly as
//      `url.parse(req.url, true)` split it — the same path, the same query
//      object, and the same null-prototype query object. A silent difference
//      here would re-route requests (`/a/../b`) or drop a query value.
//   2. NO WHATWG DECODING. The path must stay RAW. `new URL(raw)` would
//      percent-decode and dot-normalize it, so `/api/projects/%2e%2e/x`
//      would arrive as `/api/projects/../x` and match a route the client
//      never named, and src/server-web-static.js would lose the literal
//      `%2e%2e` that keeps `path.join` inside the web dir.
//
// The test drives the real server too, so a warning that only appears at
// runtime (the deprecation is emitted lazily, on first use) is caught.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-request-target-'));
process.env.MOUAIF_HOME = home;

// The parity check below calls the very API this change removes, so it has to
// call it to prove equivalence — and that call would emit the DEP0169 warning
// this test exists to catch. Suppress it for the parity phase; the server
// phase runs in a fresh child process (see below), which is the only place the
// warning can honestly be observed, because Node emits it once per process.
process.noDeprecation = true;
const url = require('node:url');

const { createServer } = require('../src/index.js');
const { parseRequestTarget } = require('../src/util.js');

// Request targets that exercise every branch of the split: a bare path, a
// query, a repeated key, a bare key, a fragment, an empty target, an
// absolute-form target, a still-encoded path, and the malformed escapes the
// decode-safety test also covers.
const TARGETS = [
  '/',
  '/api/settings',
  '/api/chats/abc?projectDir=%2Ftmp%2Fa%20b',
  '/api/ai/models?projectDir=%2Ftmp%2Fp&_bust=1',
  '/api/chats?projectDir=%2Ftmp%2Fp&limit=20&offset=0',
  '/api/x?a=1&a=2',            // repeated key -> array
  '/api/x?flag',               // bare key -> ''
  '/api/x?b=',                 // empty value -> ''
  '/api/x?',                   // empty query
  '/api/x?a=1+b',              // '+' -> space
  '/api/x?utf=%E2%9C%93',      // valid multi-byte escape
  '/api/x?p=%zz',              // malformed escape stays literal
  '/api/x?a=%E0%A4%A',         // truncated multi-byte sequence
  '/a%20b?p=1',                // encoded path stays encoded
  '/api/projects/%2e%2e/x',    // encoded dots must NOT be normalised
  '/x/%2e%2e/y',               // ditto, mid-path
  '/a/../b?x=1',               // literal dot segments stay literal
  '/x#y',                      // fragment, no query
  '/x?a=1#frag',               // fragment after the query
  '/x?#',                      // empty query + empty fragment
  '?only=query',               // query-only target
  '*',                         // asterisk-form
  'http://host/p?a=1',         // absolute-form (proxy style)
  'http://host',               // absolute-form with no path
  'https://host:8443/a/b?x=1',
  '',                          // empty target: must not be null
  // Prototype keys must stay own properties of the null-prototype query
  // object, not reach `Object.prototype`.
  '/a?__proto__=x',
  '/a?constructor=y',
  '/a?toString=z'
];

async function main() {
  // ---- 1. Parity with the deprecated parser it replaces -----------------
  let parityFailures = 0;
  for (const target of TARGETS) {
    const legacy = url.parse(target, true);
    const next = parseRequestTarget(target);
    // `url.parse` returned null for an empty/query-only/fragment-only
    // target; the replacement always yields a string so the dispatcher's
    // `startsWith` cannot throw a TypeError.
    const legacyPath = legacy.pathname === null ? '' : legacy.pathname;
    const samePath = legacyPath === next.pathname;
    const sameQuery = JSON.stringify(legacy.query) === JSON.stringify(next.query);
    const sameProto = Object.getPrototypeOf(legacy.query) === Object.getPrototypeOf(next.query);
    if (!(samePath && sameQuery && sameProto)) {
      parityFailures++;
      console.log(`  FAIL - ${JSON.stringify(target)}`);
      console.log(`         legacy ${JSON.stringify({ pathname: legacyPath, query: legacy.query })}`);
      console.log(`         next   ${JSON.stringify({ pathname: next.pathname, query: next.query })}`);
    }
  }
  console.log(`  ${parityFailures ? 'FAIL' : 'ok  '} - parity with url.parse on ${TARGETS.length} targets`);
  assert.equal(parityFailures, 0, 'parseRequestTarget must match url.parse exactly');

  // The query object stays null-prototype, so `qs()` reads a missing key as
  // absent rather than inheriting `toString`/`constructor`.
  const q = parseRequestTarget('/api/x?a=1').query;
  assert.equal(Object.getPrototypeOf(q), null);
  assert.equal(q.a, '1');
  assert.equal(q.missing, undefined);
  assert.equal(typeof q.toString, 'undefined');

  // Prototype keys are own properties of that null-prototype object.
  const protoKey = parseRequestTarget('/a?__proto__=x').query;
  assert.ok(Object.prototype.hasOwnProperty.call(protoKey, '__proto__'));
  assert.equal(Object.getPrototypeOf(protoKey), null);
  assert.equal(Object.prototype.__proto__, null, 'Object.prototype must not be polluted');
  assert.ok(Object.prototype.hasOwnProperty.call(Object.prototype, '__proto__'), 'premise: __proto__ is an accessor on Object.prototype, not a polluted value');

  // A path is never null, even for an empty target.
  for (const target of ['', '#frag', '?q=1']) {
    assert.equal(typeof parseRequestTarget(target).pathname, 'string');
  }

  // ---- 2. The path must not be decoded or dot-normalised ----------------
  // `new URL(raw, base)` would answer '/api/projects/../x' and '/x' here.
  assert.equal(parseRequestTarget('/api/projects/%2e%2e/x').pathname, '/api/projects/%2e%2e/x');
  assert.equal(parseRequestTarget('/x/%2e%2e/y').pathname, '/x/%2e%2e/y');
  assert.equal(parseRequestTarget('/a/../b').pathname, '/a/../b');
  assert.equal(parseRequestTarget('/a%20b').pathname, '/a%20b');
  const whatwg = new URL('/api/projects/%2e%2e/x', 'http://localhost');
  assert.notEqual(whatwg.pathname, '/api/projects/%2e%2e/x', 'premise: WHATWG URL normalises this');

  // ---- 3. The running server emits no deprecation warning ---------------
  // Node emits a given deprecation warning ONCE PER PROCESS, and the parity
  // phase above had to call `url.parse` to prove equivalence — so it has
  // already consumed DEP0169 in this process. Re-enabling deprecations here
  // would therefore prove nothing: the assertion passed even with the fix
  // reverted, because no second warning can ever fire.
  //
  // The only honest check is a FRESH process that never touches `url.parse`
  // and drives real requests. So the server phase runs in a child, and its
  // stderr is inspected for DEP0169 directly.
  const probe = path.join(home, 'request-target-probe.js');
  fs.writeFileSync(probe, [
    "'use strict';",
    "process.env.MOUAIF_HOME = " + JSON.stringify(path.join(home, 'probe-home')) + ';',
    "const { createServer } = require(" + JSON.stringify(path.join(__dirname, '..', 'src', 'index.js')) + ');',
    'async function main() {',
    '  const server = createServer(0, {});',
    "  await new Promise((r) => server.listen(0, '127.0.0.1', r));",
    "  const origin = 'http://127.0.0.1:' + server.address().port;",
    "  for (const t of ['/', '/api/settings', '/api/tools/list', '/api/chats/%zz', '/nope', '/api/settings?x=1']) {",
    '    const res = await fetch(origin + t);',
    '    await res.text();',
    '    if (res.status < 200 || res.status >= 600) throw new Error(t + " -> " + res.status);',
    '  }',
    '  await new Promise((r) => server.close(r));',
    '}',
    'main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });'
  ].join('\n'));

  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
  const childErr = (child.stderr || '') + (child.stdout || '');
  const sawDep0169 = /DEP0169|DeprecationWarning/.test(childErr);
  if (sawDep0169) console.log('  FAIL - runtime warning: ' + childErr.trim().split('\n')[0]);
  console.log(`  ${child.status === 0 && !sawDep0169 ? 'ok  ' : 'FAIL'} - no deprecation warning from a real request (fresh process)`);
  assert.equal(child.status, 0, 'the probe process must serve every request: ' + childErr);
  assert.equal(sawDep0169, false, 'the request path must not emit a DeprecationWarning');

  console.log('\nrequest-target parsing: all checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
