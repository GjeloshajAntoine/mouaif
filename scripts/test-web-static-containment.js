'use strict';

// Regression test for the static-file containment check.
//
// serveWebFile() refused anything outside WEB_DIR with
// `abs.startsWith(WEB_DIR)` — a prefix test, not a containment test. A
// sibling directory whose name begins with the same characters
// (`<root>/frontend-evil` next to `<root>/frontend`) passes it, so any
// future route that maps a request path onto an absolute file path would
// have served out-of-tree files. Requests cannot reach that state today
// (`url.parse` does not decode, and an encoded `%2e%2e` stays literal
// inside `path.join`), which is exactly why the boundary belongs in the
// check itself rather than in the caller.

const assert = require('node:assert/strict');
const path = require('node:path');
const { isInside } = require('../src/server-web-static.js');

const ROOT = path.resolve('/app/frontend');

const CASES = [
  // [target, expected]
  [path.join(ROOT), true],
  [path.join(ROOT, 'index.html'), true],
  [path.join(ROOT, 'assets', 'x.js'), true],
  [path.join(ROOT, '..', 'frontend', 'index.html'), true],       // normalises inside
  [path.join(ROOT, '..', 'frontend-evil', 'x.js'), false],        // the prefix trap
  [path.join(ROOT, '..', 'frontend.bak', 'x.js'), false],
  [path.join(ROOT, '..', 'etc', 'passwd'), false],
  ['/app/frontend-evil', false],
  ['/app/frontendX', false],
  ['/app', false],
  ['/', false],
  // A file whose name merely starts with the root's name.
  [ROOT + '-evil', false]
];

let passed = 0;
let failed = 0;
for (const [target, expected] of CASES) {
  const actual = isInside(ROOT, target);
  if (actual === expected) {
    passed++;
    console.log(`  ok   - ${actual ? 'inside' : 'outside'}: ${target}`);
  } else {
    failed++;
    console.log(`  FAIL - ${target}: expected ${expected}, got ${actual}`);
  }
}

// The old implementation, for contrast: it accepts the sibling directory.
const prefixSaysInside = (dir, target) => path.resolve(target).startsWith(path.resolve(dir));
assert.equal(prefixSaysInside(ROOT, '/app/frontend-evil'), true, 'the prefix test really does accept it');
assert.equal(isInside(ROOT, '/app/frontend-evil'), false);
console.log('  ok   - the prefix test accepted the sibling directory; isInside rejects it');

passed++;
console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
if (failed) process.exitCode = 1;
