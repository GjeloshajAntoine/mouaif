# New-project folder picker — implementation notes

> Agent-facing reference for [`docs/features/folder-picker.md`](../../features/folder-picker.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Programmatic (Node)

```js
const projects = require('mouaif/src/projects.js');

// List immediate subdirs at <abs>. Hidden entries (dotfiles) are skipped.
// Entries sorted case-insensitive by name.
projects.listDir('C:/Users/Admin');
// -> { dir: 'C:\\Users\\Admin', dirHasConfig, dirConfigLayout,
//      entries: [{ name, path, hasChildren, hasConfig, configLayout }, ...] }
// configLayout: 'root' (<dir>/.mouaif.json) | 'folder' (<dir>/.mouaif/.mouaif.json) | null

// Create or adopt the project config file. layout: 'root' (default) | 'folder'.
// An existing file in either layout is adopted, never moved or duplicated.
projects.ensureProjectConfig('/home/me/app', { layout: 'folder' });
// -> { path: '/home/me/app/.mouaif/.mouaif.json', layout: 'folder', created: true, adopted: false, name: 'app' }

// Create a new directory. Throws EEXIST if the directory already exists.
projects.createDir('C:/Users/Admin/mouaif-projects/my-new-app');
// -> { path: 'C:\\Users\\Admin\\mouaif-projects\\my-new-app' }

const row = projects.registerProject('C:/Users/Admin/mouaif-projects/my-app');
// -> { id: '...', path: '...', name: 'my-app', createdAt: '...' }

projects.listProjects();   // -> [{ id, path, name, createdAt }, ...]
projects.getProject(id);   // -> { id, path, name, createdAt } | null
projects.removeProject(id); // -> true | false   (does NOT delete the folder)
```

### HTTP

| Method | Path                                      | Body / Query                                              | Response                                                  |
|--------|-------------------------------------------|-----------------------------------------------------------|-----------------------------------------------------------|
| GET    | `/api/projects`                           | `?dir=<abs>` (defaults to home)                           | `{ dir, dirHasConfig, dirConfigLayout, entries: [{ name, path, hasChildren, hasConfig, configLayout }] }` |
| POST   | `/api/projects`                           | `{ "action": "list",    "dir": "<abs>" }`                 | same as GET                                               |
| POST   | `/api/projects`                           | `{ "action": "create",  "parent": "<abs>", "name": "x" }` | `201 { path, parent, name }`                              |
| POST   | `/api/projects`                           | `{ "action": "register","dir": "<abs>", "configFile"?, "configLayout"?: "root"\|"folder", "dbBacked"? }` | `{ project: { id, path, name, createdAt }, dbBacked, config: { path, layout, created, adopted, name } \| null }` |
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

- Source: [src/projects.js](../../../src/projects.js). Public surface: `listDir`, `createDir`, `registerProject`, `listProjects`, `getProject`, `removeProject`, plus `isUnderHome` / `ensureSafeRoot` / `ALLOW_ANY_ROOT` for tests.
- Storage: registered projects live in the app settings under the `projects` key (added to `DEFAULTS` in this commit, additive).
- Server wiring: [src/index.js](../../../src/index.js) → `handleProjects()`. Errors are mapped to typed HTTP statuses via `projectsErrorStatus()`.
- Error codes the UI can branch on: `EBADPATH` (400), `EOUTSIDE_HOME` (403), `ENOENT` (404), `ENOTDIR` (400), `EACCES` (403), `EEXIST` (409), `EREAD` (500).
- Config layouts: `settings.getProjectPath(dir)` returns `<dir>/.mouaif/.mouaif.json` when that file exists, else `<dir>/.mouaif.json`; every project read/write goes through it, so the layout is discovered, not stored.
- Component: [frontend/src/components/ProjectPicker.jsx](../../../frontend/src/components/ProjectPicker.jsx) (`ProjectPickerView`, routed as `projects/new?dir=…`). Folder list first; a sticky `.picker__footer` holds the storage control and the `Add "<folder>"` button.
- The storage control sits in the sticky `.picker__footer`, always visible (no collapse): a **stacked list** (`.picker__storage-list` inside `.picker__storage`, one `.picker__storage-item` per option, each a full-row `<label>` around a visually hidden radio plus a hand-drawn `.picker__storage-item-mark`), not a segmented row — three options with their consequences side by side do not fit on a phone. Each row is ≥ 44 px (measured 52 px at 390 px wide) and carries the file name and its `hint`. The `.picker__storage-note` under the list is `aria-live` and states the concrete result for the folder in view.
