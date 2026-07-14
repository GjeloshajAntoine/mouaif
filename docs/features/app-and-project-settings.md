# App and project settings

## Overview

`mouaif` resolves every setting through a three-layer merge: **built-in defaults → app-level store → project-level file**. Project values win on conflict. The app store is a single SQLite file in the user's home directory; the project file is a plain `.mouaif.json` next to the project, so it can be committed to source control.

This feature implements [docs/decisions.md §1–§2](../decisions.md).

## Usage

### Resolution

```js
const settings = require('mouaif/src/settings.js');

// Whole resolved view for a project (defaults -> app -> project).
settings.getResolved('/path/to/project');
// -> { models: [...], promptSize: 'average', flags: {}, ...appOverrides, ...projectOverrides }

// Just the app store (no merge).
settings.getApp();

// Just the project file (no merge).
settings.getProject('/path/to/project');
```

### Writing

```js
// Shallow-merge `patch` into the app store. Returns the new full app object.
settings.setApp({ promptSize: 'extensive' });

// Shallow-merge `patch` into <projectDir>/.mouaif.json. Returns the new file.
settings.setProject('/path/to/project', { promptSize: 'very-small' });
```

### HTTP

The mobile UI talks to the server, not the store directly.

| Method | Path                              | Body / Query                                  | Response                          |
|--------|-----------------------------------|-----------------------------------------------|-----------------------------------|
| GET    | `/api/settings`                   | —                                             | `{ home, defaults, app }`         |
| GET    | `/api/settings/resolved`          | `?projectDir=<absolute path>`                 | `{ resolved }`                    |
| PUT    | `/api/settings/app`               | JSON object (shallow-merged into app store)   | `{ app }`                         |
| PUT    | `/api/settings/project`           | `{ "projectDir": "<abs path>", ...patch }`    | `{ project, path }`               |

Examples:

````bash
# Read defaults + current app values.
curl http://localhost:5732/api/settings

# Read the resolved view for a project.
curl 'http://localhost:5732/api/settings/resolved?projectDir=/c/Users/Admin/code/myapp'

# Update app-level setting.
curl -X PUT http://localhost:5732/api/settings/app \
  -H 'Content-Type: application/json' \
  -d '{"promptSize":"extensive"}'

# Override at project level.
curl -X PUT http://localhost:5732/api/settings/project \
  -H 'Content-Type: application/json' \
  -d '{"projectDir":"/c/Users/Admin/code/myapp","promptSize":"very-small"}'
````

## Behavior

- **Defaults** (`src/settings.js` → `DEFAULTS`): `{ models: [], promptSize: 'average', flags: {} }`. The floor for every resolution. Trace is intentionally absent because it is opt-in per chat.
- **App store**: a single row in `app_kv` (key `settings`) inside `~/.mouaif/store.sqlite`. WAL journal mode. Created on first access.
- **Project file**: `<projectDir>/.mouaif.json`. Created on first write, 2-space indented JSON, LF line endings. Missing file is treated as `{}` (not an error).
- **Resolution order**: `defaults → app → project`. Deep-merge for plain objects. Arrays and primitives are replaced, not concatenated — project wins on any conflict.
- **Corrupt project file**: the GET returns HTTP 422 with `code: 'MOUAIF_PROJECT_PARSE_ERROR'`. The PUT overwrites the file with the patch merged into the current best-effort state.
- **Concurrency**: `better-sqlite3` is synchronous and single-process. Reads are safe; concurrent writes from the same process are serialized by the event loop. No transactions beyond a single prepared statement.

## Implementation notes

- New runtime dependency: `better-sqlite3` (`^11`). Lands in this commit.
- New file: [src/settings.js](../../src/settings.js). Public surface: `getApp`, `setApp`, `getProject`, `setProject`, `getResolved`, `getProjectPath`, `DEFAULTS`, `MOUAIF_HOME`, `close`.
- Server wiring: [src/index.js](../../src/index.js) → `handleSettings()`. The existing `GET /`, `GET /data`, `POST /data`, `GET /events` surface is unchanged.
- `MOUAIF_HOME` is overridable via the `MOUAIF_HOME` env var for tests and power users. Default: `~/.mouaif/`.

## Related

- Decisions: [docs/decisions.md §1–§2](../decisions.md).
- Future features may extend `DEFAULTS` with custom prompts or inspector flags. Trace-to-file remains a per-chat opt-in and does not add an app-wide default.
