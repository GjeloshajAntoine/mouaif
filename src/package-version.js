'use strict';

// Tiny helper for src/mcp.js to get the current mouaif version without
// dragging in the full package.json (which would couple every require
// of mcp.js to the package layout).
//
// The version comes from a build-time stamp; in this repo we read the
// package.json once at require time. A future revision can swap this
// for a generated file to avoid the cost.

const fs = require('fs');
const path = require('path');

let _version = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  if (pkg && typeof pkg.version === 'string') _version = pkg.version;
} catch { /* swallow; default version is fine for non-fatal uses */ }

module.exports = _version;
