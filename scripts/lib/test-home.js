'use strict';

// Isolate the app store for a test or probe before any src module is required.
//
// src/settings.js captures MOUAIF_HOME at require time, so this must run
// first — a later assignment has no effect and the test keeps pointing at the
// real ~/.mouaif/store.sqlite. Settings.js now refuses the real home from a
// test process, so a forgotten isolation fails loudly instead of overwriting
// the running instance's provider connections (see the 2026-08-06 incident).
//
// Usage, at the very top of scripts/test-*.js, before any require('../src/…'):
//   require('./lib/test-home.js').isolate('mouaif-<name>-');
const fs = require('fs');
const os = require('os');
const path = require('path');

function isolate(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'mouaif-test-home-'));
  process.env.MOUAIF_HOME = path.join(dir, 'home');
  // Mark the process (and any child it spawns, e.g. `bin/mouaif.js`) as a
  // test so the real home is refused even across process boundaries.
  process.env.MOUAIF_TEST = '1';
  return process.env.MOUAIF_HOME;
}

module.exports = { isolate };
