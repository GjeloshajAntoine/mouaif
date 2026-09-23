# npm package — implementation notes

> Agent-facing reference for [`docs/features/npm-package.md`](../../features/npm-package.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- The tarball contents are the `files` entry in `package.json`: `bin/`, `src/`, `frontend/dist/`, `scripts/patch-zimmerframe.js`, `README.md`, and `LICENSE`. No `.npmignore` is used.
- `bin/mouaif.js` carries a `#!/usr/bin/env node` shebang; npm links it into the global `bin` directory, which is what makes both `mouaif` and `npx mouaif` work.
- `prepublishOnly` ends with `node scripts/check-npm-name.js`. It fails when the published package belongs to another repository, passes when it is this one, and warns and continues when the registry is unreachable so an offline release is never blocked by a network hiccup.
- The repository, homepage, bug-tracker, and author metadata connect the npm listing to this repository and let the name guard verify ownership.
