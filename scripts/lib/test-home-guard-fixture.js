'use strict';

// Fixture for scripts/test-test-home-guard.js.
//
// The basename starts with `test-` and it lives under scripts/, so
// src/settings.js detects it as a test process from process.argv[1]. It does
// not set MOUAIF_HOME: the guard is what decides. Exit 0 prints OK; the guard
// refusing the real home exits non-zero.
const settings = require('../../src/settings.js');
settings.getDb();
settings.close();
console.log('GUARD_FIXTURE_OK');
