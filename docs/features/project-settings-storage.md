# Project settings storage

## Overview
By default a project's settings live in `<projectDir>/.mouaif.json` so they can be committed and hand-edited. When the project should stay untouched, **Store settings in app DB** keeps the same raw settings object in the app SQLite store (`~/.mouaif/store.sqlite`) and never writes `.mouaif.json`. This is a per-project, reversible toggle.

## Usage

### When adding a project
The folder picker asks where the project's settings live before you register it. **`.mouaif.json`** (the default) writes the file at the folder root; **`.mouaif/`** writes the same file inside a `.mouaif/` folder (`<projectDir>/.mouaif/.mouaif.json`) for complex projects; an existing file in either place is adopted instead. **App DB** keeps them in the app store and writes nothing. See [New-project folder picker](./folder-picker.md).

A file-backed project reads `<projectDir>/.mouaif/.mouaif.json` when it exists, otherwise `<projectDir>/.mouaif.json`. Everything below that says `.mouaif.json` means whichever of the two the project uses.

### In the app
Open **Settings → Project → Technical details**. The **Project settings storage** card has a single switch:

- **Off** (default): settings live in `.mouaif.json`.
- **On**: settings live in the app DB; the raw JSON editor becomes read-only and the `Save file` button is disabled.

Toggling **on** copies the current project object into the DB and leaves any existing `.mouaif.json` untouched — nothing is deleted, so switching back restores the prior file state. Toggling **off** writes the DB copy back to `.mouaif.json` and clears the DB row.

## Behavior
- **Chat artifacts follow this setting**: they live in the app DB when it is on and in `.mouaif/artifacts/` when it is off, and move when you flip it. Unlike the settings file, nothing is left behind in the old place. See [Chat artifacts](./chat-artifacts.md).
- **Storage location**: DB-backed settings are stored in the `project_settings` table of the app store, keyed by canonical `project_dir`. The value is the full raw project object (same shape as `.mouaif.json`).
- **Canonical keys**: the directory key is resolved to an absolute path before every read and write, so `/home/me/app`, `/home/me/app/` and `/home/me/app/../app` are one project rather than three. Rows written by older builds are folded onto their canonical key by the `2026-09-12-canonicalize-project-keys` migration (duplicates merged: an opted-in row wins, then the most recent MCP cache, then the newest recent-model timestamp). The same canonicalization applies to the `mcp_tool_cache` and `model_recent` tables. Writes with a non-absolute `projectDir` are rejected instead of creating an unreachable row.
- **MCP servers follow it too**: a DB-mode project keeps its MCP servers and MCP authorization rules in the `project_documents` table (`doc = 'mcp'`) and never gets a `.mcp.json` created. A `.mcp.json` that already exists is still the one read and written, in either mode, because it may be shared with other MCP clients. Switching back to file mode writes the row to `.mcp.json` (unless that file exists by then) and removes the row; switching to DB mode moves nothing. See [MCP](./mcp.md).
- **Marker**: a `__dbBacked: true` field on the stored object is the opt-in flag. It is internal bookkeeping and never exposed to the client or written to `.mouaif.json`.
- **Read/write routing**: one function, `storeFor(doc, scope, projectDir)` in `src/content/stores/index.js`, decides where a document lives and returns an adapter with `read()` and `write(next)`: the `app_kv` row for app scope, the project file, or the `project_settings` row. `getProject`, `setProject`, `unsetProjectKeys` and `getResolved` go through it. Callers that need the on-disk file specifically (e.g. the one-shot trace export) keep using the raw file helpers.
- **Switching modes**: `setProjectMode(projectDir, dbBacked)` (exposed as `settings.setDbBacked`) moves every document of the project. Asking for the mode the project is already in changes nothing, so switching on twice does not re-seed the DB from an older file.
- **Atomic writes**: project files are staged next to their target, fsynced, then renamed over it. A crash, a full disk or a killed process therefore leaves either the previous file or the complete new one — never a truncated `.mouaif.json`, which would otherwise make the settings *and* chat routes for that project answer `422` (`MOUAIF_PROJECT_PARSE_ERROR`) until the file was repaired by hand. The same writer backs the per-chat `.mouaif.messages.<id>.json` files. Saving over a file that does not parse is refused with that same error rather than silently discarding the user's content.
- **No destructive delete**: toggling the switch on never removes an existing `.mouaif.json`. Toggling off overwrites the file with the DB copy and removes the DB row through `settings.deleteDbProject`, which canonicalizes the key like every other project-scoped write — a raw delete on the request path would miss the row when the client sent a trailing slash or `..` segment, leaving the project stuck reading stale DB settings.
- **Existing file wins on first opt-in**: if the project already has a `.mouaif.json`, that content seeds the DB row so nothing is lost. This holds for both opt-in paths — the storage switch and registering a project with "store settings in the app DB" already enabled.
## Related
- [App and project settings](./app-and-project-settings.md)
- [Folder picker](./folder-picker.md)
