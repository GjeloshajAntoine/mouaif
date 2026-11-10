'use strict';

// Validate the package metadata and the files that npm would publish. This is
// intentionally dependency-free so it can run before npm install as well as
// from `prepublishOnly`.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

assert.equal(pkg.name, 'mouaif');
assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
assert.equal(pkg.main, 'src/index.js');
assert.equal(pkg.exports['.'].require, './src/index.js');
// The root must not declare a module type: `src/` is CommonJS by extension
// inference, while the `scripts/test-*.mjs` suites import `frontend/src/*.js`
// as ES modules, and a root "commonjs" type would make those imports fail.
assert.equal(pkg.type, undefined);
assert.equal(pkg.bin.mouaif, './bin/mouaif.js');
assert.ok(pkg.files.includes('frontend/dist/'));
assert.ok(fs.existsSync(path.join(ROOT, 'frontend', 'dist', 'index.html')));
assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'patch-zimmerframe.js')));

const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024
}))[0];
const names = new Set((packed.files || []).map((entry) => entry.path));
for (const file of ['package.json', 'bin/mouaif.js', 'src/index.js', 'frontend/dist/index.html', 'README.md', 'LICENSE']) {
  assert.ok(names.has(file), `npm tarball is missing ${file}`);
}
for (const file of names) {
  assert.ok(!file.startsWith('node_modules/'), `npm tarball includes ${file}`);
  assert.ok(!file.startsWith('.mouaif/'), `npm tarball includes ${file}`);
}

console.log(`[mouaif] npm package metadata is valid (${packed.entryCount} files, ${packed.size} bytes).`);
