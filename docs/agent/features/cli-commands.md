# CLI commands — implementation notes

## Why the install no longer builds

The published/user docs used to say `npm install && npm run build:web`, which
made a plain checkout depend on the reader remembering a second command. The
bundle in `frontend/dist/` is committed, so the copy shipped in the git
repository is already runnable; the build step was only needed to refresh it.

The fix moved the build into the package lifecycle instead of deleting it:

- `package.json` → `"prepare": "node scripts/prepare-web.js"` — npm runs
  `prepare` automatically after `npm install` in a source checkout (and for
  git-dependency installs). This is the only hook that fires for a fresh
  clone, and it must exist for `git clone && npm install` to be enough.
- `package.json` → `"prepack": "npm run build:web"` — `prepare` does **not**
  run for a plain `npm install mouaif`, so the bundle baked into the tarball
  is refreshed by the publish path instead (`prepublishOnly` also runs
  `build:web`; `prepack` covers `npm pack` / git-dependency cases).
- `package.json` → `"files"` already lists `frontend/dist`, so the tarball
  ships the UI. Without that entry the published package would fall back to
  serving the pre-build `frontend/` source (see `src/server-web-static.js`,
  which prefers `frontend/dist/` and falls back to `frontend/`).

## scripts/prepare-web.js

Runs from `prepare`, must never fail an install, and must not run Vite when
Vite is absent:

1. `ensureIcons()` regenerates `frontend/public/icons/*` with
   `frontend/build/generate-icons.js` (deterministic, no dependencies).
   Vite only *copies* `frontend/public/`, so a fresh clone without the
   generated icons would silently build a manifest that points at missing
   files.
2. If `node_modules/.bin/vite` is missing (`npm ci --omit=dev`,
   `NODE_ENV=production`, or a runtime-only install), it logs and returns —
   the committed `frontend/dist/` is used as-is.
3. If `frontend/dist/index.html` is at least as new as every file under
   `frontend/src/` plus `frontend/index.html` and `frontend/vite.config.js`,
   it logs "up to date" and returns. A normal install therefore costs no
   build time; a source edit does.
4. Otherwise it spawns the Vite binary directly (not through `npm run`, which
   would recurse into a lifecycle script) with `stdio: 'inherit'`.
   `spawnSync` errors and non-zero exits are logged and swallowed — a failed
   optional step must not abort `npm install`.

## Tests

`scripts/test-web-install.mjs` asserts the three surfaces above: the
`prepare`/`prepack`/`files` entries, that the hook exits 0 and reports what it
did, that a current bundle is not rebuilt, that the Vite guard precedes the
build call, and that neither `README.md`, the published guides, nor the
landing-page snippet in `scripts/build-docs.js` pairs `npm install` with
`npm run build:web` again. It is wired into `npm test` and `npm run lint`.

Note the deliberate exception in `docs/features/pwa.md`, which still shows
`npm run build:web`: there it documents the PWA plumbing (icons, manifest,
service worker) as a maintainer build, not an install step. The test's
install-snippet regex only fails the `npm install` + `build:web` pairing.

## Landing page

The "Install and run" block on the generated landing page lives inline in
`scripts/build-docs.js` (`buildLandingPage`), not in a Markdown file, so it
had to be edited in step with `docs/features/getting-started.md`. The test
pins both.

## Implementation notes

- The command surface is defined with `commander` in `bin/mouaif.js`: `serve`, `info`, and `import-chats` (plus `--version` from the package metadata). The default port constant is shared with the server (`src/index.js`).
- `mouaif serve` always runs as a supervisor process that spawns and respawns a worker. The supervisor keeps the process alive across restarts from `POST /api/restart` and across source changes with `--watch`, so a restart always loads the code currently on disk.
- The built UI lives at `frontend/dist/` and is served by `src/server-web-static.js`. `npm run build:web` exists for frontend development; it is not a required installation step.
- The package `files` list (`package.json`) ships `bin/`, `src/`, `frontend/dist/`, `scripts/patch-zimmerframe.js`, `README.md`, and `LICENSE`, so an installed package contains the whole server, the pre-built UI, and the license.
- `bin/mouaif.js` carries a `#!/usr/bin/env node` shebang; npm links it into the global `bin` directory, which is what makes both `mouaif` and `npx mouaif` work.
- `version` in `package.json` must be a full semantic version (`0.3.0`, not `0.3`). The npm registry rejects the bare two-part form with a `400`, so `npm publish` refuses to start until it is fixed. The root package version in `package-lock.json` stays aligned with it.
- `publishConfig` explicitly selects the public npm registry and public package access. The repository, homepage, and issue tracker metadata connect the npm listing to this repository and let the package-name guard verify ownership.
- `postinstall` runs `scripts/patch-zimmerframe.js`, which must therefore stay in the published tarball — a missing script file fails the install of an already-unpacked package. `scripts/prepare-web.js` only runs in a checkout and is intentionally not published.
- `prepublishOnly` ends with `node scripts/check-npm-name.js`, which asks the registry whether the `mouaif` name is still free and aborts the publish if it now belongs to another repository. It warns and continues when the registry is unreachable, so an offline release is never blocked by a network hiccup.

## Related

- [CLI commands](../../features/cli-commands.md) — the public page.
- [Docs site](../../features/docs-site.md) — how the published pages are built.
