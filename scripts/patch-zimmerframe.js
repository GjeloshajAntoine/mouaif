// postinstall patch: zimmerframe is ESM-only with no `require` export
// condition, but `@preact/preset-vite`'s `transform-hook-names` plugin
// loads it via `require('zimmerframe')` from a CJS file. On Node 22
// this throws `No "exports" main defined` and the dev server is
// unusable for any JSX file that uses hooks.
//
// We rewrite zimmerframe's `package.json` to expose `./src/walk.js`
// as the CJS entry too. The package is one file (~3 KB) that re-exports
// the same symbols as the ESM entry, so a thin CJS wrapper is enough.
//
// This is a no-op if zimmerframe isn't installed, if it already has
// a `require` field, or if the file is read-only.

'use strict';

const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules', 'zimmerframe', 'package.json');
if (!fs.existsSync(target)) {
  // No zimmerframe installed (project doesn't use @preact/preset-vite
  // with this Node version, or a peer dep was skipped). Nothing to do.
  process.exit(0);
}

let pkg;
try { pkg = JSON.parse(fs.readFileSync(target, 'utf8')); }
catch (e) {
  console.error('patch-zimmerframe: could not read', target, e.message);
  process.exit(0);
}

// Idempotency: if we already added a `require` field, leave the file
// alone. We use a marker in the description to detect re-runs.
if (pkg.exports && pkg.exports['.'] && pkg.exports['.']['require']) {
  process.exit(0);
}

// Add the `require` condition. The `import` condition keeps working
// exactly as before; CJS users now resolve to the same ESM source
// file, which Node 22 can load as CJS via `require(esm)`.
pkg.exports = pkg.exports || {};
pkg.exports['.'] = Object.assign({}, pkg.exports['.'] || {}, {
  require: './src/walk.js',
  import: pkg.exports['.'] && pkg.exports['.'].import ? pkg.exports['.'].import : './src/walk.js'
});

// Marker so re-runs of the script don't double-apply. The description
// is human-readable only; the require field is the real signal.
pkg.description = (pkg.description || '') + ' [patched for CJS interop]';

try {
  fs.writeFileSync(target, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('patch-zimmerframe: added `require` condition to zimmerframe/package.json');
} catch (e) {
  // Read-only filesystems (CI sandboxes, locked deps) are non-fatal.
  console.error('patch-zimmerframe: could not write', target, e.message);
}
