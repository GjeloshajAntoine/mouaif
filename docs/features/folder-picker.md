# New-project folder picker

## Overview

Two surfaces, one feature. The mobile UI can **browse the filesystem** to pick a folder for a new project, and it can **register** the chosen folder so the app remembers it across sessions. The picker lists the immediate subdirectories of any absolute path, with a "create new folder" action that mints a sibling directory and registers it in one step. Implemented in [docs/decisions.md §4](../decisions.md).

## Usage

### Filesystem surface (the picker)

```js
const projects = require('mouaif/src/projects.js');

// List immediate subdirs at <abs>. Hidden entries (dotfiles) are skipped.
// Entries sorted case-insensitive by name.
projects.listDir('C:/Users/Admin');
// -> { dir: 'C:\\Users\\Admin', entries: [{ name, path, hasChildren }, ...] }

// Create a new directory. Throws EEXIST if the directory already exists.
projects.createDir('C:/Users/Admin/mouaif-projects/my-new-app');
// -> { path: 'C:\\Users\\Admin\\mouaif-projects\\my-new-app' }
```

### Registered projects (the user's chosen projects)

```js
const row = projects.registerProject('C:/Users/Admin/mouaif-projects/my-app');
// -> { id: '...', path: '...', name: 'my-app', createdAt: '...' }

projects.listProjects();   // -> [{ id, path, name, createdAt }, ...]
projects.getProject(id);   // -> { id, path, name, createdAt } | null
projects.removeProject(id); // -> true | false   (does NOT delete the folder)
```

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
# Browse the user home.
curl 'http://localhost:5732/api/projects'

# List subdirs of a specific path.
curl 'http://localhost:5732/api/projects?dir=C:/Users/Admin/mouaif-projects'

# Create a new folder (does NOT register it).
curl -X POST http://localhost:5732/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"action":"create","parent":"C:/Users/Admin/mouaif-projects","name":"new-app"}'

# Register an existing folder as a project.
curl -X POST http://localhost:5732/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"action":"register","dir":"C:/Users/Admin/mouaif-projects/new-app"}'

# Unregister (keeps the folder on disk).
curl -X DELETE http://localhost:5732/api/projects/registered/<id>
````

## Behavior

- **Hidden entries are skipped**: any directory whose name starts with `.` is not listed. Picker noise is the most common complaint, and dotfiles are almost never what a user wants to pick.
- **Non-dirs are skipped**: regular files, symlinks-to-files, and broken symlinks are filtered out.
- **Native order, then case-insensitive alpha**: `fs.readdirSync` order, then a stable locale-aware name sort. The picker feels predictable across platforms.
- **`hasChildren` is computed once at list time**, by checking for at least one immediate subdir. Mobile UI uses this to draw the disclosure chevron without a second round-trip.
- **Path safety**: every absolute path passed to `listDir` / `createDir` / `registerProject` must resolve to a descendant of the user home directory. Otherwise the call fails with `EOUTSIDE_HOME` (HTTP 403). To opt out, set `MOUAIF_ALLOW_ANY_ROOT=1` in the environment.
- **Registration is deduped by canonical path**: registering the same path twice returns the existing row instead of creating a duplicate.
- **Removing a registered project does NOT delete the folder on disk.** The user owns the file; mouaif just forgets it.
- **Default `dir` is the user home** when none is provided. The mobile UI opens at home and lets the user drill down.

## Implementation notes

- Source: [src/projects.js](../../src/projects.js). Public surface: `listDir`, `createDir`, `registerProject`, `listProjects`, `getProject`, `removeProject`, plus `isUnderHome` / `ensureSafeRoot` / `ALLOW_ANY_ROOT` for tests.
- Storage: registered projects live in the app settings under the `projects` key (added to `DEFAULTS` in this commit, additive).
- Server wiring: [src/index.js](../../src/index.js) → `handleProjects()`. Errors are mapped to typed HTTP statuses via `projectsErrorStatus()`.
- Error codes the UI can branch on: `EBADPATH` (400), `EOUTSIDE_HOME` (403), `ENOENT` (404), `ENOTDIR` (400), `EACCES` (403), `EEXIST` (409), `EREAD` (500).

## Related

- Decision: [docs/decisions.md §4](../decisions.md).
- Stored alongside the rest of app-level settings per [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
- The next feature that consumes registered projects is the **project card** ([decisions §9](../decisions.md)).
