# Project settings storage
## Overview
By default a project's settings live in `<projectDir>/.mouaif.json` so they can be committed and hand-edited. When the project should stay untouched, **Store settings in app DB** keeps the same raw settings object in the app SQLite store (`~/.mouaif/store.sqlite`) and never writes `.mouaif.json`. This is a per-project, reversible toggle.

## Usage
### In the app
Open **Settings → Project → Technical details**. The **Project settings storage** card has a single switch:

- **Off** (default): settings live in `.mouaif.json`.
- **On**: settings live in the app DB; the raw JSON editor becomes read-only and the `Save file` button is disabled.

Toggling **on** copies the current project object into the DB and leaves any existing `.mouaif.json` untouched — nothing is deleted, so switching back restores the prior file state. Toggling **off** writes the DB copy back to `.mouaif.json` and clears the DB row.

### HTTP
| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET | `/api/settings/project/storage` | `?projectDir=<absolute path>` | `{ dbBacked: boolean }` |
| PUT | `/api/settings/project/storage` | `{ "projectDir": "<abs path>", "dbBacked": boolean }` | `{ dbBacked, project, path }` |
Examples:
```bash
# Is this project DB-backed?
curl 'http://localhost:5732/api/settings/project/storage?projectDir=/abs/project'

# Move it into the DB (no .mouaif.json writes from here on).
curl -X PUT http://localhost:5732/api/settings/project/storage \
-H 'Content-Type: application/json' \
-d '{"projectDir":"/abs/project","dbBacked":true}'

# Move it back to the .mouaif.json file.
curl -X PUT http://localhost:5732/api/settings/project/storage \
-H 'Content-Type: application/json' \
-d '{"projectDir":"/abs/project","dbBacked":false}'
```
`GET /api/settings/project` also returns `dbBacked` and sets `path` to `null` when DB-backed.

## Behavior
- **Storage location**: DB-backed settings are stored in the `project_settings` table of the app store, keyed by canonical `project_dir`. The value is the full raw project object (same shape as `.mouaif.json`).
- **Marker**: a `__dbBacked: true` field on the stored object is the opt-in flag. It is internal bookkeeping and never exposed to the client or written to `.mouaif.json`.
- **Read/write routing**: `getProject`, `setProject`, `unsetProjectKeys`, and `getResolved` all route to the DB row when the project is DB-backed; otherwise they use the file. Callers that need the on-disk file specifically (e.g. the one-shot trace export) keep using the raw file helpers.
- **No destructive delete**: toggling the switch on never removes an existing `.mouaif.json`. Toggling off overwrites the file with the DB copy.
- **Existing file wins on first opt-in**: if the project already has a `.mouaif.json`, that content seeds the DB row so nothing is lost.
## Implementation notes
- Source: [src/settings.js](../../src/settings.js) — `project_settings` table, `getDbProjectRaw`, `isDbBacked`, `setDbBacked`, plus routing in `getProject` / `setProject` / `unsetProjectKeys` / `getResolved`.
- REST: [src/server-handlers-settings.js](../../src/server-handlers-settings.js) — `GET`/`PUT /api/settings/project/storage`; `GET`/`PUT /api/settings/project` now include `dbBacked`.
- UI: [frontend/src/components/SettingsProject.jsx](../../frontend/src/components/SettingsProject.jsx) — the storage card in Technical details; [frontend/src/api.js](../../frontend/src/api.js) — `getProjectStorage` / `setProjectStorage`.
- Test: [scripts/test-project-db-backed.js](../../scripts/test-project-db-backed.js).
## Related
- [App and project settings](./app-and-project-settings.md)
- [Folder picker](./folder-picker.md)
