# Project settings storage

## Overview
By default a project's settings live in `<projectDir>/.mouaif.json` so they can be committed and hand-edited. When the project should stay untouched, **Store settings in app DB** keeps the same raw settings object in the app SQLite store (`~/.mouaif/store.sqlite`) and never writes `.mouaif.json`. This is a per-project, reversible toggle.

## Usage

### In the app
Open **Settings → Project → Technical details**. The **Project settings storage** card has a single switch:

- **Off** (default): settings live in `.mouaif.json`.
- **On**: settings live in the app DB; the raw JSON editor becomes read-only and the `Save file` button is disabled.

Toggling **on** copies the current project object into the DB and leaves any existing `.mouaif.json` untouched — nothing is deleted, so switching back restores the prior file state. Toggling **off** writes the DB copy back to `.mouaif.json` and clears the DB row.

## Behavior
- **Storage location**: DB-backed settings are stored in the `project_settings` table of the app store, keyed by canonical `project_dir`. The value is the full raw project object (same shape as `.mouaif.json`).
- **Canonical keys**: the directory key is resolved to an absolute path before every read and write, so `/home/me/app`, `/home/me/app/` and `/home/me/app/../app` are one project rather than three. Rows written by older builds are folded onto their canonical key by the `2026-09-12-canonicalize-project-keys` migration (duplicates merged: an opted-in row wins, then the most recent MCP cache, then the newest recent-model timestamp). The same canonicalization applies to the `mcp_tool_cache` and `model_recent` tables. Writes with a non-absolute `projectDir` are rejected instead of creating an unreachable row.
- **Marker**: a `__dbBacked: true` field on the stored object is the opt-in flag. It is internal bookkeeping and never exposed to the client or written to `.mouaif.json`.
- **Read/write routing**: `getProject`, `setProject`, `unsetProjectKeys`, and `getResolved` all route to the DB row when the project is DB-backed; otherwise they use the file. Callers that need the on-disk file specifically (e.g. the one-shot trace export) keep using the raw file helpers.
- **Atomic writes**: project files are staged next to their target, fsynced, then renamed over it. A crash, a full disk or a killed process therefore leaves either the previous file or the complete new one — never a truncated `.mouaif.json`, which would otherwise make the settings *and* chat routes for that project answer `422` (`MOUAIF_PROJECT_PARSE_ERROR`) until the file was repaired by hand. The same writer backs the per-chat `.mouaif.messages.<id>.json` files. Saving over a file that does not parse is refused with that same error rather than silently discarding the user's content.
- **No destructive delete**: toggling the switch on never removes an existing `.mouaif.json`. Toggling off overwrites the file with the DB copy and removes the DB row through `settings.deleteDbProject`, which canonicalizes the key like every other project-scoped write — a raw delete on the request path would miss the row when the client sent a trailing slash or `..` segment, leaving the project stuck reading stale DB settings.
- **Existing file wins on first opt-in**: if the project already has a `.mouaif.json`, that content seeds the DB row so nothing is lost. This holds for both opt-in paths — the storage switch and registering a project with "store settings in the app DB" already enabled.
## Related
- [App and project settings](./app-and-project-settings.md)
- [Folder picker](./folder-picker.md)
