# Test coverage guard

A meta-test that keeps every test file wired into an npm script, so tests cannot silently drift out of CI.

## Overview

`scripts/test-test-coverage.js` checks that every `scripts/test-*` file is referenced in `package.json`, that no npm script claims a syntax check as a test, and that known-exempt files are tracked. It runs first in `npm test` and fails fast with an actionable message.

## Usage

```bash
npm test                          # runs the guard first, then all tests
node scripts/test-test-coverage.js # run the guard alone
```

When the guard fails, it prints which test files are orphaned and what to do:

```
  FAIL - every test file on disk is referenced in package.json (or exempt) :: 3 test file(s) not wired into any npm script:
  scripts/test-new-feature.js

Add them to the "test" script (or a test:* group) in package.json,
or add them to EXEMPT in scripts/test-test-coverage.js with a reason.
```

## Implementation notes

The guard checks seven things:

| Check | What it catches |
|-------|-----------------|
| Every test file on disk is referenced in `package.json` | New tests added without wiring them into CI |
| Every referenced test file exists on disk | Renamed/deleted files leaving dangling references |
| No `node --check` on a test file inside a `test:*` script | Syntax checks masquerading as behavioral tests |
| `test` script exists | Accidental deletion of the main test entry |
| `test` script runs ≥ 100 test files | Mass removal of tests from the suite |
| Helper fixture servers are not run directly as tests | Fixture servers (`test-mcp-server.js`, …) executed as standalone tests |
| `BROKEN_TESTS` entries still exist on disk | Broken tests removed without updating the tracking list |

### Exempt files

Some test files legitimately cannot run in `npm test`. They are listed in the guard with a reason:

```js
// scripts/test-test-coverage.js
const HELPERS = new Set([
  'test-mcp-server.js',        // fixture server spawned by other tests
  'test-mcp-cancel-server.js',
  'test-mcp-names-server.js',
  'test-mcp-crash-server.js',
]);

const CHROME_TESTS = new Set([
  'test-direct-cdp.cjs',       // needs debug Chrome on :9222
  'test-inspector-cdp.cjs',
  'test-inspector-cdp-direct.cjs',
  'test-auth-model-picker.cjs',  // wired into npm run test:chrome
  'test-model-picker.cjs',
  'test-model-picker-chat.cjs',
]);

const MANUAL_TESTS = new Set([
  'test-mcp-ui.mjs',           // browser harness, prints URL for a human
]);

const BROKEN_TESTS = new Set([
  'test-mcp-http.js',          // 3 failures: known bugs, tracked for fixing
  'test-mcp-ondemand.js',      // EMCP_NOSESSION: known bug, tracked for fixing
]);
```

### npm scripts

| Script | Purpose |
|--------|---------|
| `npm test` | Runs the guard first, then all CI-safe tests (194 files) |
| `npm run test:browser-build` | Tests that need the web bundle (`frontend/dist`) built first |
| `npm run test:chrome` | Tests that need the debug Chrome on `:9222` |

The browser-build and chrome tests are wired into separate scripts so `npm test` stays fast and dependency-free on a fresh clone.
