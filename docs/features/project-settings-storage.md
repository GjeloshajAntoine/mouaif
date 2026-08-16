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
- **Marker**: a `__dbBacked: true` field on the stored object is the opt-in flag. It is internal bookkeeping and never exposed to the client or written to `.mouaif.json`.
- **Read/write routing**: `getProject`, `setProject`, `unsetProjectKeys`, and `getResolved` all route to the DB row when the project is DB-backed; otherwise they use the file. Callers that need the on-disk file specifically (e.g. the one-shot trace export) keep using the raw file helpers.
- **No destructive delete**: toggling the switch on never removes an existing `.mouaif.json`. Toggling off overwrites the file with the DB copy.
- **Existing file wins on first opt-in**: if the project already has a `.mouaif.json`, that content seeds the DB row so nothing is lost.
## Related
- [App and project settings](./app-and-project-settings.md)
- [Folder picker](./folder-picker.md)
