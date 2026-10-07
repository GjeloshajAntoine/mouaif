# Test coverage guard — implementation notes

> Agent-facing reference for [`docs/features/test-coverage-guard.md`](../../features/test-coverage-guard.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

`scripts/test-test-coverage.js` (no API, no fixtures) inspects `package.json` and `scripts/`. It runs first in the `test` script, so an orphaned test fails the suite in under a second instead of silently never running. It checks seven things:

| Check | What it catches |
|-------|-----------------|
| Every test file on disk is referenced in `package.json` | New tests added without wiring them into CI |
| Every referenced test file exists on disk | Renamed/deleted files leaving dangling references |
| No `node --check` on a test file inside a `test:*` script | Syntax checks masquerading as behavioral tests |
| `test` script exists | Accidental deletion of the main test entry |
| `test` script runs ≥ 100 test files | Mass removal of tests from the suite |
| Helper fixture servers are not run directly as tests | Fixture servers (`test-mcp-server.js`, …) executed as standalone tests |
| `BROKEN_TESTS` entries still exist on disk | Broken tests removed without updating the tracking list |

The failure message names the offending files and the two ways to resolve them: wire the file into an npm script, or add it to `EXEMPT` with a reason.

### Exempt files

Some test files legitimately cannot run in `npm test`, so they are tracked in named sets with a reason rather than dropped:

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

The browser-build and chrome tests are in separate scripts so `npm test` stays fast and dependency-free on a fresh clone.
