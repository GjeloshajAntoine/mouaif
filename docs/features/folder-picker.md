# New-project folder picker

## Overview

The folder picker allows you to browse local directories and register any codebase as a project in mouaif, or create a brand-new directory in one tap. When you register a folder you also choose **where that project's settings live**: in a `.mouaif.json` config file inside the folder, or in the app database so the folder stays untouched.

## Usage

1. In the **Projects** (Chats) tab, tap **+ Add project**.
2. Browse your folder tree:
   - Tap a folder to view its subdirectories.
   - Tap **Up** to navigate to the parent folder.
   - Tap **Select this folder** or the **✓** button to register the current folder immediately.
3. Choose the **storage** for this project's settings (see below), then select the folder.
4. **Create a new folder** — enter a name in the *Create new folder* input at the bottom and tap **Create**. The folder is created on disk and opened immediately so you can select and register it.

## Where a project's settings live

The storage choice appears under the folder list and applies to the folder you are about to register:

| Option | What happens |
| --- | --- |
| **Config file in the folder** (default) | The project's settings are kept in `.mouaif.json` at the folder root. If the folder does not have one yet, it is **written now** with the project's name, so the file is there to be committed and hand-edited. If the folder **already** has one, that file is **adopted as-is** — it is never overwritten. |
| **Store in app DB** | The settings are kept in the app SQLite store (`~/.mouaif/store.sqlite`). **No file is written** to the folder, so nothing shows up in git. |

The two options are mutually exclusive: a project whose settings live in the app database never reads `.mouaif.json`, so the picker will not write one for it.

Rows for folders that already contain a `.mouaif.json` show a small `.mouaif.json` badge, so an existing config file is visible before you open the folder.

## Behavior

- **Safety & clean view** — hidden folders (dotfiles such as `.git` or `.cache`) are filtered out to keep the picker clean. A folder's own `.mouaif.json` is still reported as a badge.
- **Non-destructive** — unregistering a project from mouaif only removes it from your project list; your files and folders on disk are never deleted. Adopting an existing config file leaves its bytes untouched.
- **Corrupt config file** — adopting a `.mouaif.json` that does not parse fails with a parse error rather than overwriting your bytes. Repair the file (or register with **Store in app DB**) and try again.
- **Home directory default** — the picker starts at your user home directory and lets you navigate into any workspace.

## Implementation notes

- `POST /api/projects` with `{ action: 'register', dir, configFile, dbBacked }`. `configFile: true` runs the ensure step; it is ignored when `dbBacked: true`. The response carries `config: { path, created, adopted, name }` (or `null`).
- The create/adopt logic lives in `src/projects.js` (`ensureProjectConfig`, `hasConfig`, `configPath`). Writes reuse the staged + fsync + atomic-rename writer in `src/settings.js`, so an interrupted write can never leave a truncated file.
- `GET /api/projects?dir=<abs>` reports `dirHasConfig` for the listed folder and `hasConfig` on each entry, which is what the picker turns into the badge and the live option note.

## Related

- [Project card](./project-card.md) — managing registered projects and project chats.
- [Project settings storage](./project-settings-storage.md) — moving an existing project between the config file and the app database.
- [App and project settings](./app-and-project-settings.md) — the defaults → app → project resolution order.
