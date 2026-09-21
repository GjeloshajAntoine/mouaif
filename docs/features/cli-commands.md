# CLI commands

## Overview

The `mouaif` command starts the app, prints build information, and imports chats from a legacy storage format. The UI bundle is shipped inside the package (`frontend/dist/`), so a normal installation never builds the frontend — `mouaif serve` serves the committed bundle as-is.

## Usage

### Install

Run the app without installing anything, straight from the registry:

```bash
npx mouaif serve
```

`npx` unpacks the package into its own cache (`~/.npm/_npx`) and launches the CLI from there, so it never writes to the directory you run it from. The first run downloads the native binaries (`better-sqlite3`, `@napi-rs/keyring`) and can take a few minutes; later runs reuse the cache. To pin an exact version, quote the argument — a bare `mouaif@0.3.0` is a glob to `zsh` and fails with `no matches found`:

```bash
npx --yes --package "mouaif@0.3.0" mouaif info
```

Install the published package globally:

```bash
npm install -g mouaif
```

Or install from a checkout of this repository:

```bash
git clone <repo-url>
cd mouaif
npm install
npm link
```

`npm install` also builds the web UI through the package `prepare` script when the Vite toolchain is present, so a fresh clone works even if `frontend/dist/` is missing from the checkout. `npm link` makes the `mouaif` command available in your terminal.

Every published tarball contains the pre-built UI in `frontend/dist/`, so `npm install -g mouaif` and `npx mouaif` serve the shipped bundle without building anything. `better-sqlite3` and `@napi-rs/keyring` ship prebuilt binaries for common platforms; where none exists, Node compiles them during install and the first install takes a few minutes.

### Publish a release

The package is configured to publish publicly to the official npm registry. Authenticate as a maintainer, choose a new semantic version, and publish from a clean checkout:

```bash
npm login
npm version patch
npm publish
```

`npm publish` runs the full `prepublishOnly` verification before uploading. The `publishConfig` in `package.json` pins `https://registry.npmjs.org/` and public access, so a developer-level registry override cannot accidentally send the CLI to another registry.

### Serve

Starts the HTTP server for the web UI at `http://127.0.0.1:5732/` and keeps running until `Ctrl+C`.

| Option | Default | Purpose |
|--------|---------|---------|
| `-p, --port <port>` | `5732` | Port to listen on. |
| `-h, --host <host>` | `127.0.0.1` | Host to bind to. Use `0.0.0.0` to reach the app from other devices. |
| `--public-origin <origin>` | `MOUAIF_PUBLIC_ORIGIN` | Public HTTP(S) origin when the app is served through a proxy. |
| `-w, --watch` | off | Restart the server when local source files change. |
| `--auth` | off | Require app access authentication. |
| `--user <user>` | — | Set the app access user before serving. |
| `--password <password>` | `MOUAIF_PASSWORD` | Set the app access password before serving. Prefer the environment variable to keep the password out of shell history. |
| `--auth-setup` | off | Print a one-time setup link, QR code, and short code, then exit. |

```bash
mouaif serve --port 9000
mouaif serve --host 0.0.0.0
mouaif serve --watch
```

#### Access authentication

```bash
# One-time setup link, QR code, and short code
mouaif serve --auth-setup

# Set a user without putting the password in shell history
MOUAIF_PASSWORD='a-long-password' \
  mouaif serve --auth --user alice
```

`--user` and `--password` (or `MOUAIF_PASSWORD`) must be supplied together. After setup, `mouaif serve --auth` requires login on every start. Use HTTPS and `--public-origin` before exposing the app outside the machine that runs it.

### Info

```bash
mouaif info
```

Prints the package version, the description, and the default port. It does not start the server.

### Import chats

```bash
mouaif import-chats <projectDir> [--skip-existing]
```

Imports chat transcripts from the legacy `.mouaif.messages.*.json` files of one project into the SQLite chat store. `<projectDir>` must be an absolute path to an existing directory; `--skip-existing` imports only chats and messages that are not stored yet. The command reports the number of chats and messages imported and lists per-file errors without aborting.

The automatic startup migration that used to run this import has been retired, so this is the only entry point for a JSON transcript history.

## Implementation notes

- The command surface is defined with `commander` in `bin/mouaif.js`: `serve`, `info`, and `import-chats` (plus `--version` from the package metadata). The default port constant is shared with the server (`src/index.js`).
- `mouaif serve` always runs as a supervisor process that spawns and respawns a worker. The supervisor keeps the process alive across restarts from `POST /api/restart` and across source changes with `--watch`, so a restart always loads the code currently on disk.
- The built UI lives at `frontend/dist/` and is served by `src/server-web-static.js`. `npm run build:web` exists for frontend development; it is not a required installation step.
- The package `files` list (`package.json`) ships `bin/`, `src/`, `frontend/dist/`, and `README.md`, so an installed package contains the whole server and the pre-built UI.
- `bin/mouaif.js` carries a `#!/usr/bin/env node` shebang; npm links it into the global `bin` directory, which is what makes both `mouaif` and `npx mouaif` work.
- `version` in `package.json` must be a full semantic version (`0.3.0`, not `0.3`). The npm registry rejects the bare two-part form with a `400`, so `npm publish` refuses to start until it is fixed. The root package version in `package-lock.json` stays aligned with it.
- `publishConfig` explicitly selects the public npm registry and public package access. The repository, homepage, and issue tracker metadata connect the npm listing to this repository and let the package-name guard verify ownership.
- `postinstall` runs `scripts/patch-zimmerframe.js`, which must therefore stay in the published tarball — a missing script file fails the install of an already-unpacked package. `scripts/prepare-web.js` only runs in a checkout and is intentionally not published.
- `prepublishOnly` ends with `node scripts/check-npm-name.js`, which asks the registry whether the `mouaif` name is still free and aborts the publish if it now belongs to another repository. It warns and continues when the registry is unreachable, so an offline release is never blocked by a network hiccup.

## Related

- [Getting started](./getting-started.md) — install the app and complete first setup.
- [Authentication](./authentication.md) — connect AI providers and protect app access.
- [REST and SSE server](./rest-and-sse-server.md) — the HTTP surface that `mouaif serve` exposes.