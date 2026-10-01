'use strict';

// Regression test for the app-store guard in src/settings.js.
//
// Tests and probes run in-process against src/ modules, and a missing — or
// too-late — MOUAIF_HOME used to let them open the real ~/.mouaif/store.sqlite.
// A `settings.setApp({ providers: [...] })` from such a run replaced the whole
// provider array and deleted real connections (2026-08-06 incident). The guard
// now refuses the default home from a test process so the mistake fails loudly.
//
// Child processes use fake user homes, so a broken guard never opens the
// developer's store. Cover argv detection, marker-only children, node --test,
// symlink aliases (including missing leaf directories), and the override.
//
// Run: node scripts/test-test-home-guard.js
require('./lib/test-home.js').isolate('mouaif-guard-');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FIXTURE = path.join(__dirname, 'lib', 'test-home-guard-fixture.js');

// A clean environment with a fake default home: no isolation, test marker,
// node --test context, or override inherited from the parent.
function cleanEnv(overrides) {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-guard-user-'));
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome };
  delete env.MOUAIF_HOME;
  delete env.MOUAIF_TEST;
  delete env.NODE_TEST_CONTEXT;
  delete env.MOUAIF_ALLOW_REAL_HOME;
  return Object.assign(env, overrides || {});
}

function run(env, markerOnly) {
  // -e has no test-named entry: only an inherited marker can identify it.
  const args = markerOnly ? ['-e', 'require(' + JSON.stringify(FIXTURE) + ')'] : [FIXTURE];
  return spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 30000 });
}

function assertRefused(r, env) {
  assert.equal(r.status, 1, 'the fixture must exit non-zero; stdout: ' + r.stdout);
  assert.match(r.stderr, /Refusing to open the real app store/);
  assert.equal(fs.existsSync(path.join(env.HOME, '.mouaif', 'store.sqlite')), false,
    'the default store must not be created');
}

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   - ' + name); }
  catch (err) { fail++; console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]); }
}

check('a test with no isolated home is refused before opening the default store', () => {
  const env = cleanEnv();
  assertRefused(run(env), env);
});

check('an isolated MOUAIF_HOME opens normally', () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-guard-home-')), 'home');
  const r = run(cleanEnv({ MOUAIF_HOME: home }));
  assert.equal(r.status, 0, 'the fixture must succeed; stderr: ' + r.stderr);
  assert.match(r.stdout, /GUARD_FIXTURE_OK/);
});

check('an inherited MOUAIF_TEST=1 refuses a child with no test entry', () => {
  const env = cleanEnv({ MOUAIF_TEST: '1' });
  assertRefused(run(env, true), env);
});

check('NODE_TEST_CONTEXT refuses a child with no test entry', () => {
  const env = cleanEnv({ NODE_TEST_CONTEXT: 'child-v8' });
  assertRefused(run(env, true), env);
});

check('a non-test process can still open its default home', () => {
  const env = cleanEnv();
  const r = run(env, true);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /GUARD_FIXTURE_OK/);
  assert.equal(fs.existsSync(path.join(env.HOME, '.mouaif', 'store.sqlite')), true);
});

check('a symlink to the default home is refused', () => {
  const env = cleanEnv();
  const home = path.join(env.HOME, '.mouaif');
  fs.mkdirSync(home);
  env.MOUAIF_HOME = path.join(env.HOME, 'store-alias');
  fs.symlinkSync(home, env.MOUAIF_HOME, process.platform === 'win32' ? 'junction' : 'dir');
  assertRefused(run(env), env);
});

check('a parent symlink is refused even before the default home exists', () => {
  const env = cleanEnv();
  const alias = path.join(env.HOME, 'user-alias');
  fs.symlinkSync(env.HOME, alias, process.platform === 'win32' ? 'junction' : 'dir');
  env.MOUAIF_HOME = path.join(alias, '.mouaif');
  assertRefused(run(env), env);
});

check('the default home is canonicalized when it is itself a symlink', () => {
  const env = cleanEnv();
  env.MOUAIF_HOME = path.join(env.HOME, 'store-target');
  fs.mkdirSync(env.MOUAIF_HOME);
  fs.symlinkSync(env.MOUAIF_HOME, path.join(env.HOME, '.mouaif'),
    process.platform === 'win32' ? 'junction' : 'dir');
  assertRefused(run(env), env);
});

check('a symlink to an isolated home still opens normally', () => {
  const env = cleanEnv();
  const home = path.join(env.HOME, 'isolated');
  fs.mkdirSync(home);
  env.MOUAIF_HOME = path.join(env.HOME, 'isolated-alias');
  fs.symlinkSync(home, env.MOUAIF_HOME, process.platform === 'win32' ? 'junction' : 'dir');
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(home, 'store.sqlite')), true);
  assert.equal(fs.existsSync(path.join(env.HOME, '.mouaif', 'store.sqlite')), false);
});

check('MOUAIF_ALLOW_REAL_HOME=1 deliberately allows the fake default home', () => {
  const env = cleanEnv({ MOUAIF_ALLOW_REAL_HOME: '1' });
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /GUARD_FIXTURE_OK/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
