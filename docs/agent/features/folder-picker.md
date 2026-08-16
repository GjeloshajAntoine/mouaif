# New-project folder picker — implementation notes

> Agent-facing reference for [`docs/features/folder-picker.md`](../../features/folder-picker.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### HTTP

| Method | Path                                      | Body / Query                                              | Response                                                  |
|--------|-------------------------------------------|-----------------------------------------------------------|-----------------------------------------------------------|
| GET    | `/api/projects`                           | `?dir=<abs>` (defaults to home)                           | `{ dir, entries: [{ name, path, hasChildren }] }`         |
| POST   | `/api/projects`                           | `{ "action": "list",    "dir": "<abs>" }`                 | same as GET                                               |
| POST   | `/api/projects`                           | `{ "action": "create",  "parent": "<abs>", "name": "x" }` | `201 { path, parent, name }`                              |
| POST   | `/api/projects`                           | `{ "action": "register","dir": "<abs>" }`                 | `{ project: { id, path, name, createdAt } }`              |
| GET    | `/api/projects/registered`                | —                                                         | `{ projects: [...] }`                                     |
| DELETE | `/api/projects/registered/:id`            | —                                                         | `{ ok: true }` (404 if unknown id)                        |

Examples:

````bash
curl 'http://localhost:5732/api/projects'

curl 'http://localhost:5732/api/projects?dir=C:/Users/Admin/mouaif-projects'

curl -X POST http://localhost:5732/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"action":"create","parent":"C:/Users/Admin/mouaif-projects","name":"new-app"}'

curl -X POST http://localhost:5732/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"action":"register","dir":"C:/Users/Admin/mouaif-projects/new-app"}'

curl -X DELETE http://localhost:5732/api/projects/registered/<id>
````

## Implementation notes

- Source: [src/projects.js](../../src/projects.js). Public surface: `listDir`, `createDir`, `registerProject`, `listProjects`, `getProject`, `removeProject`, plus `isUnderHome` / `ensureSafeRoot` / `ALLOW_ANY_ROOT` for tests.
- Storage: registered projects live in the app settings under the `projects` key (added to `DEFAULTS` in this commit, additive).
- Server wiring: [src/index.js](../../src/index.js) → `handleProjects()`. Errors are mapped to typed HTTP statuses via `projectsErrorStatus()`.
- Error codes the UI can branch on: `EBADPATH` (400), `EOUTSIDE_HOME` (403), `ENOENT` (404), `ENOTDIR` (400), `EACCES` (403), `EEXIST` (409), `EREAD` (500).
