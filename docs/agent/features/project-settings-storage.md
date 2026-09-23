# Project settings storage — implementation notes

> Agent-facing reference for [`docs/features/project-settings-storage.md`](../../features/project-settings-storage.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### HTTP
| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET | `/api/settings/project/storage` | `?projectDir=<absolute path>` | `{ dbBacked: boolean }` |
| PUT | `/api/settings/project/storage` | `{ "projectDir": "<abs path>", "dbBacked": boolean }` | `{ dbBacked, project, path }` |
Examples:
```bash
curl 'http://localhost:5732/api/settings/project/storage?projectDir=/abs/project'

curl -X PUT http://localhost:5732/api/settings/project/storage \
-H 'Content-Type: application/json' \
-d '{"projectDir":"/abs/project","dbBacked":true}'

curl -X PUT http://localhost:5732/api/settings/project/storage \
-H 'Content-Type: application/json' \
-d '{"projectDir":"/abs/project","dbBacked":false}'
```
`GET /api/settings/project` also returns `dbBacked` and sets `path` to `null` when DB-backed.

## Implementation notes
- Source: [src/settings.js](../../../src/settings.js) — `project_settings` table, `getDbProjectRaw`, `isDbBacked`, `setDbBacked`, plus routing in `getProject` / `setProject` / `unsetProjectKeys` / `getResolved`.
- REST: [src/server-handlers-settings.js](../../../src/server-handlers-settings.js) — `GET`/`PUT /api/settings/project/storage`; `GET`/`PUT /api/settings/project` now include `dbBacked`.
- UI: [frontend/src/components/SettingsProject.jsx](../../../frontend/src/components/SettingsProject.jsx) — the storage card in Technical details; [frontend/src/api.js](../../../frontend/src/api.js) — `getProjectStorage` / `setProjectStorage`.
- Test: [scripts/test-project-db-backed.js](../../../scripts/test-project-db-backed.js).
