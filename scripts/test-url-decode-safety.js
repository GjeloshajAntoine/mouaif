'use strict';

// Regression test for the malformed-percent-escape crash.
//
// Every REST route that reads an id out of the path used to call
// decodeURIComponent directly from inside an async handler. A raw path
// segment such as `%zz` raises a URIError there, and because the route
// table calls its handlers without awaiting them, the rejection escaped
// as an unhandledRejection — which Node's default
// `--unhandled-rejections=throw` turns into a process exit. A single
// unauthenticated GET could therefore kill the server.
//
// The test drives the real server over HTTP with a set of malformed
// paths and asserts that (a) the process stays alive and (b) the
// response is a normal HTTP error, never a hang or a crash.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-url-decode-'));
process.env.MOUAIF_HOME = home;

const { createServer } = require('../src/index.js');
const { safeDecode } = require('../src/util.js');

// Paths whose id segment contains an invalid percent escape, a bare
// percent, or a truncated multi-byte sequence. Each one matched a route
// that decoded the segment before dispatching to a domain module.
const MALFORMED = [
  '/api/chats/%zz',
  '/api/chats/%zz/messages',
  '/api/chats/%E0%A4%A',
  '/api/prompts/%zz',
  '/api/mcp/servers/%zz',
  '/api/tools/authorization/%zz',
  '/api/actions/%zz',
  '/api/auth/accounts/%zz',
  '/api/access/passkeys/%zz',
  '/api/projects/%zz/tags',
  '/api/projects/%zz/tags/files/%zz',
  '/api/chats/%'
];

async function main() {
  // safeDecode is the shared primitive: it must never throw and must
  // hand back the raw text so the request becomes a 400/404.
  assert.equal(safeDecode('%zz'), '%zz');
  assert.equal(safeDecode('%E0%A4%A'), '%E0%A4%A');
  assert.equal(safeDecode('%'), '%');
  assert.equal(safeDecode('abc'), 'abc');
  assert.equal(safeDecode('a%20b'), 'a b');
  assert.equal(safeDecode(null), '');
  assert.equal(safeDecode(undefined), '');
  assert.equal(safeDecode(42), '');

  const server = createServer(0, {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;

  let failures = 0;
  let serverErrors = 0;
  const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} - ${label}`);
    if (!ok) failures++;
  };

  try {
    for (const target of MALFORMED) {
      // No Origin header: this is the plain-CLI shape the dispatcher
      // admits without a browser session, i.e. the unauthenticated case.
      const res = await fetch(origin + target);
      const body = await res.text();
      // A crash would surface as a fetch failure (caught below); a
      // handler-level failure surfaces as an explicit 500 EINTERNAL.
      const crashed = /EINTERNAL/.test(body);
      if (crashed) serverErrors++;
      check(`GET ${target} → ${res.status} (no crash)`, res.status >= 200 && res.status < 600 && !crashed);
    }

    // The server must still serve a normal request after all of that.
    const alive = await fetch(origin + '/api/settings');
    check('server still serving after malformed paths', alive.status === 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${MALFORMED.length + 1} checks, ${failures} failed (${serverErrors} unhandled handler errors)`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
