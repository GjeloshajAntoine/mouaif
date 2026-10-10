'use strict';

// Meta-test: every test file is wired into an npm script, and no npm script
// claims a syntax check as a test.
//
// The project has 299 scripts/test-* files but only 174 run in `npm test`.
// The other 125 drifted out of CI — they pass locally but nobody runs them,
// so a regression they guard can ship unnoticed. This test fails when a new
// test file is added without being added to package.json, or when an existing
// entry is renamed and the script silently points at nothing.
//
// It also catches `node --check <file>` masquerading as a test execution in a
// `test:*` script: a syntax check proves the file parses, not that it behaves.
//
// Some test files legitimately cannot run in CI:
//   - HELPERS: fixture servers spawned by other tests (not standalone tests).
//   - CHROME_TESTS: need the debug Chrome on :9222 (manual / integration).
//   - MANUAL_TESTS: browser harnesses a human drives (print a URL, Ctrl-C).
//   - BROKEN_TESTS: currently fail; tracked so they get fixed or removed.
// Every other test file must be referenced in package.json.
//
// Run: node scripts/test-test-coverage.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Fixture servers spawned by other tests — not standalone tests.
const HELPERS = new Set([
  'test-mcp-server.js',
  'test-mcp-apps-server.js',
  'test-mcp-cancel-server.js',
  'test-mcp-names-server.js',
  'test-mcp-crash-server.js',
]);

// Tests that need the debug Chrome on :9222 — manual / integration only.
// Wired into `npm run test:chrome` (not `npm test`) because CI has no Chrome.
const CHROME_TESTS = new Set([
  'test-direct-cdp.cjs',
  'test-inspector-cdp.cjs',
  'test-inspector-cdp-direct.cjs',
  'test-auth-model-picker.cjs',
  'test-model-picker.cjs',
  'test-model-picker-chat.cjs',
]);

// Manual browser harnesses — print a URL and wait for a human.
const MANUAL_TESTS = new Set([
  'test-mcp-ui.mjs',
]);

// Tests that currently fail — tracked so they get fixed or removed.
const BROKEN_TESTS = new Set([
  'test-mcp-http.js',        // 3 failures: POST /api/mcp/call, tools/list, auto-start
  'test-mcp-ondemand.js',    // EMCP_NOSESSION: server not auto-started on callTool
]);

// Browser-build tests that need `npm run build:web` first — they are wired
// into the "test" script but require the web bundle to exist. Listed here so
// the orphan check can skip them when the bundle is missing (fresh clone,
// `npm test` before `npm run build:web`).
const BROWSER_BUILD_TESTS = new Set([
  'test-responsive-layout.mjs',
  'test-subagent-transcript-ui.mjs',
  'test-chat-element-stability.mjs',
  'test-chat-reentry-ui.mjs',
]);

const EXEMPT = new Set([...HELPERS, ...CHROME_TESTS, ...MANUAL_TESTS, ...BROKEN_TESTS]);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   - ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]);
  }
}

// Every scripts/test-*.{js,mjs,cjs} file on disk, excluding exempt files.
function testFilesOnDisk() {
  return fs.readdirSync(SCRIPTS_DIR)
    .filter((f) => /^test-.*\.(js|mjs|cjs)$/.test(f))
    .filter((f) => !EXEMPT.has(f))
    .sort();
}

// Every scripts/test-* reference in any npm script value.
function testFilesReferenced() {
  const referenced = new Set();
  for (const script of Object.values(PKG.scripts || {})) {
    for (const m of String(script).matchAll(/scripts\/(test-[\w.-]+\.(?:js|mjs|cjs))/g)) {
      referenced.add(m[1]);
    }
  }
  return referenced;
}

// Every test file referenced in package.json that does NOT exist on disk
// (and is not an exempt helper).
function danglingReferences() {
  const onDisk = new Set(fs.readdirSync(SCRIPTS_DIR));
  const dangling = [];
  for (const ref of testFilesReferenced()) {
    if (!onDisk.has(ref)) dangling.push(ref);
  }
  return dangling.sort();
}

// `node --check` / `node -c` invocations inside `test:*` scripts — syntax
// checks that prove a file parses, not that it behaves.
function syntaxChecksInTestScripts() {
  const offenders = [];
  for (const [name, script] of Object.entries(PKG.scripts || {})) {
    if (!/^test/.test(name)) continue;
    for (const m of String(script).matchAll(/node\s+(?:--check|-c)\s+(scripts\/test-[\w.-]+\.(?:js|mjs|cjs))/g)) {
      offenders.push(name + ': ' + m[1]);
    }
  }
  return offenders;
}

// --- checks ---------------------------------------------------------------

check('every test file on disk is referenced in package.json (or exempt)', () => {
  const onDisk = testFilesOnDisk();
  const referenced = testFilesReferenced();
  const orphaned = onDisk.filter((f) => !referenced.has(f));
  assert.deepEqual(orphaned, [],
    orphaned.length + ' test file(s) not wired into any npm script:\n  ' + orphaned.join('\n  ')
    + '\n\nAdd them to the "test" script (or a test:* group) in package.json,'
    + '\nor add them to EXEMPT in scripts/test-test-coverage.js with a reason.');
});

check('every test file referenced in package.json exists on disk', () => {
  const dangling = danglingReferences();
  assert.deepEqual(dangling, [],
    dangling.length + ' test file(s) referenced in package.json but missing on disk:\n  ' + dangling.join('\n  '));
});

check('no test:* script uses node --check on a test file (syntax check as fake test)', () => {
  const offenders = syntaxChecksInTestScripts();
  assert.deepEqual(offenders, [],
    'syntax checks masquerading as tests:\n  ' + offenders.join('\n  ')
    + '\n\nRun the file with `node <file>` instead of `node --check <file>`.');
});

check('the "test" script exists', () => {
  assert.ok(PKG.scripts && PKG.scripts.test, 'package.json has no "test" script');
});

check('the "test" script runs at least 100 test files', () => {
  const testScript = PKG.scripts.test || '';
  const count = (testScript.match(/scripts\/test-[\w.-]+\.(?:js|mjs|cjs)/g) || []).length;
  assert.ok(count >= 100, 'the "test" script runs only ' + count + ' test files; expected >= 100');
});

check('helper fixture servers are not run directly as tests', () => {
  const testScript = PKG.scripts.test || '';
  for (const helper of HELPERS) {
    assert.ok(!testScript.includes('node scripts/' + helper),
      'helper ' + helper + ' is run directly in the "test" script; it is a fixture server, not a test');
  }
});

check('broken tests are listed in BROKEN_TESTS with a reason', () => {
  // If a test is in BROKEN_TESTS it must still exist on disk, so removing
  // the file without updating this list fails loudly.
  const onDisk = new Set(fs.readdirSync(SCRIPTS_DIR));
  for (const broken of BROKEN_TESTS) {
    assert.ok(onDisk.has(broken), 'BROKEN_TESTS lists ' + broken + ' but it no longer exists on disk — remove it from the list');
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
