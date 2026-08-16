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

## Behavior

- **Hidden entries are skipped**: any directory whose name starts with `.` is not listed. Picker noise is the most common complaint, and dotfiles are almost never what a user wants to pick.
- **Non-dirs are skipped**: regular files, symlinks-to-files, and broken symlinks are filtered out.
- **Native order, then case-insensitive alpha**: `fs.readdirSync` order, then a stable locale-aware name sort. The picker feels predictable across platforms.
- **`hasChildren` is computed once at list time**, by checking for at least one immediate subdir. Mobile UI uses this to draw the disclosure chevron without a second round-trip.
- **Path safety**: every absolute path passed to `listDir` / `createDir` / `registerProject` must resolve to a descendant of the user home directory. Otherwise the call fails with `EOUTSIDE_HOME` (HTTP 403). To opt out, set `MOUAIF_ALLOW_ANY_ROOT=1` in the environment.
- **Registration is deduped by canonical path**: registering the same path twice returns the existing row instead of creating a duplicate.
- **Removing a registered project does NOT delete the folder on disk.** The user owns the file; mouaif just forgets it.
- **Default `dir` is the user home** when none is provided. The mobile UI opens at home and lets the user drill down.

## Mobile UI

The hash route `#/projects/new?dir=<abs>` is the on-screen filesystem browser. The projects list has a **+ Add project** primary button that navigates to it (with `dir` empty, so the API defaults to the user home). From there:

- The current path is shown at the top in monospace, in a small card.
- **Up** walks one level (hidden when at the home root).
- **Select this folder** registers the current directory and bounces back to `#/projects`, where the new card appears (the `projectsReload` signal in the projects view is bumped to trigger the refetch).
- Each row shows the folder name on the left. If the folder has immediate subdirs, an **Open** button drills into it (the URL becomes `#/projects/new?dir=<encoded>`). If it's a leaf, the Open button is replaced with a muted `empty` label so the row stays informative without offering a useless action.
- A **Select** button on every row registers that folder (no need to drill in just to register).
- A `Create new folder` disclosure at the bottom captures a name, mints the directory under the current parent, and drills into the new folder on success so the user can see it and (optionally) register it. A failed create surfaces the typed error in the status line (e.g. `EEXIST Directory already exists`).

Touch targets are at least 44 × 44 px (`--tap`); long lists scroll inside the picker card. The picker is fully DOM-direct (no JSX subtree per row) to keep the small-list cost down and the first paint fast.

## Related

- Decision: [docs/decisions.md §4](../decisions.md).
- Stored alongside the rest of app-level settings per [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
- The feature that consumes registered projects on the projects list is the **project card** ([docs/features/project-card.md](./project-card.md)).
- The picker UI itself is implemented in [frontend/src/main.jsx](../../frontend/src/main.jsx) (the `ProjectPickerView` component and the `projects/new?dir=…` route).
