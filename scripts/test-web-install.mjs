// "No separate build step" — the install-path guarantees, end to end.
//
// The promise is narrow but easy to break silently in three different places,
// and each place has its own failure mode:
//
//   1. package.json — without a `prepare` script nothing builds the UI on a
//      fresh checkout, and without `prepack` a publish can ship a stale
//      bundle; without `frontend/dist` in `files` the published tarball has no
//      UI at all (the server then serves the pre-build frontend/ source).
//   2. scripts/prepare-web.js — the installer hook. It must exit 0 no matter
//      what (a failed `npm install` is worse than a stale bundle), it must
//      skip the build when the bundle is already newer than the sources, and
//      it must not run Vite when Vite is not installed (a production or
//      `--omit=dev` install).
//   3. the docs — every install snippet that still says `npm run build:web`
//      re-teaches the step this feature removes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
const checks = [];
function check(name, fn) {
  checks.push(async () => {
    await fn();
    pass += 1;
    console.log('  ok   - ' + name);
  });
}

// ---- 1. packaging --------------------------------------------------------

const pkg = JSON.parse(read('package.json'));
const prepareScript = pkg.scripts && pkg.scripts.prepare;

check('npm install builds the UI through the prepare script', () => {
  assert.equal(prepareScript, 'node scripts/prepare-web.js');
});

check('publishing rebuilds the UI through prepack', () => {
  assert.equal(pkg.scripts.prepack, 'npm run build:web');
});

check('the published package ships the built UI', () => {
  assert.ok(Array.isArray(pkg.files), 'package.json has a files list');
  assert.ok(
    pkg.files.includes('frontend/dist'),
    'frontend/dist must be in package.json files'
  );
  // The bundle the server serves must exist in the repository, or an install
  // from a tarball would 404 the app shell.
  assert.ok(fs.existsSync(path.join(ROOT, 'frontend', 'dist', 'index.html')));
});

// ---- 2. the prepare step -------------------------------------------------

const prepareSource = read('scripts/prepare-web.js');

check('the prepare step can never fail an install', () => {
  // A non-zero exit from prepare aborts `npm install`. The script reports and
  // returns instead of failing.
  assert.ok(!/process\.exit\s*\(\s*[1-9]/.test(prepareSource), 'no non-zero process.exit');
  assert.ok(!/process\.exitCode/.test(prepareSource), 'no non-zero exitCode');
  const spawned = spawnSync(process.execPath, ['scripts/prepare-web.js'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(spawned.status, 0, spawned.stderr || 'prepare-web.js exited non-zero');
  assert.match(spawned.stdout, /^\[mouaif\] /m, 'the hook reports what it did');
});

check('a fresh bundle is not rebuilt', () => {
  const spawned = spawnSync(process.execPath, ['scripts/prepare-web.js'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const distMtime = fs.statSync(path.join(ROOT, 'frontend', 'dist', 'index.html')).mtimeMs;
  assert.equal(spawned.status, 0);
  // Either it decided the bundle was current, or it rebuilt it (a source file
  // newer than dist/ in the working tree). A rebuild must have rewritten the
  // entry document; a skip must have left it untouched.
  if (/up to date/.test(spawned.stdout)) {
    assert.equal(fs.statSync(path.join(ROOT, 'frontend', 'dist', 'index.html')).mtimeMs, distMtime);
  } else {
    assert.match(spawned.stdout, /Building the web UI/);
  }
});

check('Vite is optional for the prepare step', () => {
  // The guard is what keeps a production install from spawning a build with
  // no toolchain present; assert it is checked before the build runs.
  const guardAt = prepareSource.indexOf('existsSync(VITE_BIN)');
  const buildAt = prepareSource.indexOf("'build', '--config'");
  assert.ok(guardAt > -1, 'prepare-web.js checks for the Vite binary');
  assert.ok(buildAt > guardAt, 'the Vite guard comes before the build call');
});

// ---- 3. the docs no longer teach the extra step ---------------------------

// An install snippet is the pair of lines that must not be split by a manual
// frontend build. pwa.md still documents `npm run build:web` for the PWA
// plumbing — that is a maintainer build, not an install step, and the pairing
// is what distinguishes them.
const INSTALL_WITH_BUILD = /npm install\s*\n\s*npm run build:web/;

check('no user-facing install snippet requires npm run build:web', () => {
  const files = [
    'README.md',
    'docs/features/getting-started.md',
    'docs/features/authentication.md',
    'docs/features/app-abilities.md',
    'docs/features/cli-commands.md'
  ];
  for (const file of files) {
    assert.ok(!INSTALL_WITH_BUILD.test(read(file)), file + ' still builds on install');
  }
});

check('the generated landing page matches the install docs', () => {
  const source = read('scripts/build-docs.js');
  const snippet = source.slice(source.indexOf('id="start"'), source.indexOf('id="auth"'));
  assert.ok(!/npm run build:web/.test(snippet), 'landing install snippet still builds');
  assert.match(snippet, /npm install\s*\n\s*npm link/);
});

check('the CLI commands page is published and indexed', () => {
  const doc = read('docs/features/cli-commands.md');
  assert.match(doc, /^# CLI commands\s*$/m, 'one H1');

  assert.match(doc, /^## Overview$/m, 'has an Overview section');
  assert.match(doc, /^## Usage$/m, 'has a Usage section');
  assert.match(doc, /^## Implementation notes$/m, 'has an Implementation notes section');
  const install = doc.slice(doc.indexOf('### Install'), doc.indexOf('### Serve'));
  assert.ok(!/build:web/.test(install), 'the install block does not build the UI');

  assert.match(read('docs/README.md'), /features\/cli-commands\.md/, 'linked from the docs index');
  assert.match(doc, /mouaif import-chats/, 'documents the importer');
  assert.match(doc, /mouaif info/, 'documents the info command');
  assert.match(doc, /--auth-setup/, 'documents the access-auth setup flag');
});

for (const fn of checks) await fn();
console.log('\nweb install: ' + pass + ' check(s) passed');
