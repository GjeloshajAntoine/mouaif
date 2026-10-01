# Test isolation and the app-store guard

Implementation notes for the guard that stops a test from touching the real
app store. Maintainer material — not published with the user guide.

## Why

Test and probe scripts run in-process against `src/` modules. `src/settings.js`
captures `MOUAIF_HOME` **at require time**:

```js
const MOUAIF_HOME = process.env.MOUAIF_HOME || path.join(os.homedir(), '.mouaif');
```

so setting `MOUAIF_HOME` after the first `require('../src/settings.js')` has no
effect, and a script that never sets it opens the real
`~/.mouaif/store.sqlite`. `setApp()` is a shallow merge (`{ ...current, ...patch }`),
so a fixture that passes `providers: [...]` **replaces the whole provider
array**. Every unisolated run therefore deleted the user's real connections and
left only the test's mock entry (a loopback `baseUrl`, the test-only `type`
field, no `auth`) — recorded in the 2026-08-06 incident and again on
2026-10-01, when the `openrouter` connection was lost.

## The guard

`src/settings.js` refuses the default home from a test process, before it ever
opens the DB:

- `isTestProcess()` is true when `NODE_TEST_CONTEXT` is set (`node --test`),
  when `MOUAIF_TEST=1`, or when the entry script (`process.argv[1]`) lives under
  `scripts/` and its basename starts with `test` or `probe`.
- `assertStoreHomeSafe(home)` throws `MOUAIF_REAL_HOME_IN_TEST` when a test
  process would open `DEFAULT_HOME` (`~/.mouaif`), including symlink aliases.
  `canonicalStoreHome()` resolves both paths through the filesystem; when a
  directory is missing, it resolves the nearest existing parent and appends
  the missing components without creating anything.
- At module load a detected test process sets `process.env.MOUAIF_TEST = '1'`,
  so a child it spawns (`bin/mouaif.js serve`, a pty shell) is refused too.
  A test that only spawns children and never loads `settings.js` must call
  `isolate()` before spawning; `test-restart-supervisor.js` does this too.
- `MOUAIF_ALLOW_REAL_HOME=1` is the deliberate override for a one-off run
  against the real store.

The running server and CLI are not test processes, so they keep the default
home.

## Writing a test or probe

Set the home **before** any `src` require, or nothing works:

```js
require('./lib/test-home.js').isolate('mouaif-my-test-');
// now safe to require src modules
const settings = require('../src/settings.js');
```

`scripts/lib/test-home.js` points `MOUAIF_HOME` at a fresh temp directory and
sets `MOUAIF_TEST=1`.

## Files

- `src/settings.js` — `isTestProcess()`, `canonicalStoreHome()`,
  `assertStoreHomeSafe()`, the guard call in `db()`, and child-marker propagation.
- `scripts/lib/test-home.js` — `isolate(prefix)` helper.
- `scripts/lib/test-home-guard-fixture.js` — child used to assert the guard.
- `scripts/test-test-home-guard.js` — regression tests for argv detection,
  marker-only children (using `node -e`, not a test-named entry), Node's test
  context, default and isolated symlink aliases, missing leaf directories,
  and the deliberate override. Every default home is a fake temp user home,
  so even a broken guard cannot touch the developer's store.
- `scripts/test-restart-supervisor.js` — isolates before spawning its CLI child
  and verifies `/api/settings` reports that same home before and after restarts.
