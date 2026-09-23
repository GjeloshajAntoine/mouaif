# App and project settings — implementation notes

> Agent-facing reference for [`docs/features/app-and-project-settings.md`](../../features/app-and-project-settings.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Programmatic (Node)

```js
const settings = require('mouaif/src/settings.js');

// Whole resolved view for a project (defaults -> app -> project).
settings.getResolved('/path/to/project');
// -> { providers: [...], models: [...], promptSize: 'average', flags: {}, ... }

// Just the app store (no merge).
settings.getApp();

// Just the project file (no merge).
settings.getProject('/path/to/project');

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
| GET    | `/api/usage/builtin`              | —                                             | `{ ids, table }` — built-in model-pricing table for the Settings → Model pricing page |

Examples:

````bash
curl http://localhost:5732/api/settings

curl 'http://localhost:5732/api/settings/resolved?projectDir=/c/Users/Admin/code/myapp'

curl -X PUT http://localhost:5732/api/settings/app \
  -H 'Content-Type: application/json' \
  -d '{"promptSize":"extensive"}'

curl -X PUT http://localhost:5732/api/settings/project \
  -H 'Content-Type: application/json' \
  -d '{"projectDir":"/c/Users/Admin/code/myapp","promptSize":"very-small"}'
````

## Implementation notes

- New runtime dependency: `better-sqlite3` (`^11`). Lands in this commit.
- New file: [src/settings.js](../../../src/settings.js). Public surface: `getApp`, `setApp`, `getProject`, `setProject`, `getResolved`, `getProjectPath`, `DEFAULTS`, `MOUAIF_HOME`, `close`.
- Server wiring: [src/index.js](../../../src/index.js) → `handleSettings()`. The existing `GET /`, `GET /data`, `POST /data`, `GET /events` surface is unchanged.
- `MOUAIF_HOME` is overridable via the `MOUAIF_HOME` env var for tests and power users. Default: `~/.mouaif/`.
- Model pricing table: a `modelPricing` key on the app store, shaped as `{ "<modelId>": { inputPer1K, outputPer1K } }`. Edited through Settings → Model pricing; consumed by [src/usage.js](../../../src/usage.js) and surfaced in the chat UI as the per-turn cost line. See [docs/features/usage-metrics.md](./usage-metrics.md).
- Client redaction allowlist: `GET`/`PUT /api/settings/*` responses pass through `settingsForClient()` in [src/index.js](../../../src/index.js), which copies only an allowlist of non-secret keys (`providers` with `apiKey` redacted, `models`, `projects`, `promptSize`, `githubCopilot`, `modelPricing`, `authAccounts`, `tools`, `toolOutput`, `flags`) and drops server-only bookkeeping.
- Redaction round-trips: `PUT /api/settings/app` and `PUT /api/settings/project` both sanitize `providers`/`models` patches before persisting — the response-only `hasApiKey` marker is stripped, and an entry re-submitted without `apiKey` keeps the previously stored key.
- Concurrency: `better-sqlite3` is synchronous and single-process.

## Decisions

- [docs/decisions.md](../../decisions.md): §1 (SQLite storage), §2 (project overrides app), §3 (providers and models).
