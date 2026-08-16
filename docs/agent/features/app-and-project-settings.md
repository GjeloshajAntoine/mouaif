# App and project settings — implementation notes

> Agent-facing reference for [`docs/features/app-and-project-settings.md`](../../features/app-and-project-settings.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

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
- New file: [src/settings.js](../../src/settings.js). Public surface: `getApp`, `setApp`, `getProject`, `setProject`, `getResolved`, `getProjectPath`, `DEFAULTS`, `MOUAIF_HOME`, `close`.
- Server wiring: [src/index.js](../../src/index.js) → `handleSettings()`. The existing `GET /`, `GET /data`, `POST /data`, `GET /events` surface is unchanged.
- `MOUAIF_HOME` is overridable via the `MOUAIF_HOME` env var for tests and power users. Default: `~/.mouaif/`.
- Model pricing table: a `modelPricing` key on the app store, shaped as `{ "<modelId>": { inputPer1K, outputPer1K } }`. Edited through Settings → Model pricing; consumed by [src/usage.js](../../src/usage.js) and surfaced in the chat UI as the per-turn cost line. See [docs/features/usage-metrics.md](./usage-metrics.md).
