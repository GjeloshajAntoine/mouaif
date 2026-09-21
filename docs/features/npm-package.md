# npm package

## Overview

`mouaif` is published to the public npm registry as the package [`mouaif`](https://www.npmjs.com/package/mouaif), which exposes a command of the same name. Installing the package is the supported way to run the app anywhere Node.js is available; `npx mouaif serve` runs it without a global install.

## Usage

Run the app straight from the registry, without installing it:

```bash
npx mouaif serve --auth
```

Install the command globally:

```bash
npm install -g mouaif
mouaif serve --auth
```

Pin an exact version (quote the argument so the shell does not read `@` as a glob):

```bash
npx --yes --package "mouaif@0.3.0" mouaif info
```

### Publish a release

From a clean checkout, as a maintainer:

```bash
npm login
npm version patch   # or minor / major
npm publish
```

`npm publish` runs `prepublishOnly` before uploading: the lint pass, the frontend build, the documentation build, and the npm-name guard. The name guard asks the registry whether `mouaif` is still free and aborts the publish if it now belongs to a different repository.

## Behavior

- **Public access.** `publishConfig` pins `https://registry.npmjs.org/` and `access: public`, so a developer-level registry override cannot send the release to another registry.
- **Pre-built UI.** Every tarball ships `frontend/dist/`, so `npx mouaif` and a global install never run a frontend build. `scripts/prepare-web.js` builds the UI only in a source checkout.
- **Native dependencies.** `better-sqlite3` and `@napi-rs/keyring` ship prebuilt binaries for common platforms; where none exists, Node compiles them during install, so the first install can take a few minutes.
- **`postinstall` patch.** The install runs `scripts/patch-zimmerframe.js`, which is why that single script file stays in the tarball.
- **Semantic versions only.** `version` must be a full `X.Y.Z`; the registry rejects the two-part form with a 400.

## Implementation notes

- The tarball contents are the `files` entry in `package.json`: `bin/`, `src/`, `frontend/dist/`, `scripts/patch-zimmerframe.js`, `README.md`, and `LICENSE`. No `.npmignore` is used.
- `bin/mouaif.js` carries a `#!/usr/bin/env node` shebang; npm links it into the global `bin` directory, which is what makes both `mouaif` and `npx mouaif` work.
- `prepublishOnly` ends with `node scripts/check-npm-name.js`. It fails when the published package belongs to another repository, passes when it is this one, and warns and continues when the registry is unreachable so an offline release is never blocked by a network hiccup.
- The repository, homepage, bug-tracker, and author metadata connect the npm listing to this repository and let the name guard verify ownership.

## Related

- [CLI commands](./cli-commands.md) — every `mouaif` command and `serve` option.
- [Getting started](./getting-started.md) — install, run, and first setup.
