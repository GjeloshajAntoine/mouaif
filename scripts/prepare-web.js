// scripts/prepare-web.js
//
// Runs from the package `prepare` script, which npm executes after
// `npm install` in a source checkout (and again before a publish / git
// dependency install). Its only job is to make sure the web UI bundle in
// frontend/dist/ exists, so `mouaif serve` always has something to serve
// without the user having to remember a separate build step.
//
// It stays out of the way when a build is neither needed nor possible:
//   - a published package already ships frontend/dist/, and `prepare` never
//     runs for a plain `npm install mouaif` anyway;
//   - `npm ci --omit=dev` / `NODE_ENV=production` installs have no Vite
//     binary on disk, so a build there would only fail — the committed
//     bundle is used instead;
//   - a dist/ that is newer than every frontend source file is left alone,
//     so a normal install costs no build time.
//
// Exit code 0 always: `prepare` must not turn a working install into a
// failed one.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'frontend', 'src');
const DIST_INDEX = path.join(ROOT, 'frontend', 'dist', 'index.html');
const VITE_BIN = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vite.cmd' : 'vite'
);

function log(message) {
  process.stdout.write('[mouaif] ' + message + '\n');
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(abs));
    else if (entry.isFile()) newest = Math.max(newest, fs.statSync(abs).mtimeMs);
  }
  return newest;
}

// The sources whose change should trigger a rebuild: the whole frontend
// tree except the build output itself, plus the Vite config.
function newestSourceMtime() {
  let newest = 0;
  if (fs.existsSync(SRC_DIR)) newest = newestMtime(SRC_DIR);
  for (const name of ['index.html', 'vite.config.js']) {
    const abs = path.join(ROOT, 'frontend', name);
    if (fs.existsSync(abs)) newest = Math.max(newest, fs.statSync(abs).mtimeMs);
  }
  return newest;
}

// The Vite build copies frontend/public/ verbatim, so the generated icons
// must exist before it runs. The generator is deterministic and overwrites
// its outputs, so regenerating on every install is cheap and keeps a fresh
// checkout from building a manifest with missing icon files.
function ensureIcons() {
  const generator = path.join(ROOT, 'frontend', 'build', 'generate-icons.js');
  if (!fs.existsSync(generator)) return;
  const result = spawnSync(process.execPath, [generator], { cwd: ROOT, stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    log('Icon generation skipped; the icon files already in frontend/public/ are used.');
  }
}

function main() {
  ensureIcons();

  if (!fs.existsSync(VITE_BIN)) {
    log('Vite is not installed; keeping the bundled web UI in frontend/dist/.');
    return;
  }

  const distMtime = fs.existsSync(DIST_INDEX) ? fs.statSync(DIST_INDEX).mtimeMs : 0;
  if (distMtime >= newestSourceMtime()) {
    log('Web UI is up to date; skipping the frontend build.');
    return;
  }

  log('Building the web UI (frontend/dist/)...');
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'frontend/vite.config.js'],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (result.error) {
    log('Web UI build could not run (' + result.error.message + '); keeping frontend/dist/ as-is.');
    return;
  }
  if (result.status !== 0) {
    log('Web UI build failed; keeping frontend/dist/ as-is.');
    return;
  }
  log('Web UI built.');
}

try {
  main();
} catch (error) {
  log('Web UI prepare step skipped: ' + (error && error.message ? error.message : error));
}
