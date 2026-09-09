# Hide file content

## Overview

Per-project settings page that marks specific line ranges of a source file as hidden from the agent file tools. When the model calls `read_file` the hidden lines come back as `[hidden]`, and `search_files` silently skips any match on a hidden line. The on-disk file is never modified, so the redaction stays purely on the model-facing side.

## Usage

Open **Settings → This project → More settings → Hide file content**, or navigate directly to `#/settings/project/hide`.

1. Tap **+ Add file**, or tap a saved file row to edit it.
2. The dedicated editor shows the original file with line numbers. Tap a line to hide it; tap it again to show it. Selected lines have a highlight and check mark.
3. For larger selections, expand **Enter line ranges manually** and enter inclusive **From** / **To** numbers. Invalid values are explained rather than silently changed. Adjacent and overlapping ranges are merged on save.
4. Tap **Save**. The editor returns to the file list only after saving succeeds. A failed save keeps the selection available for retry, and controls are disabled while a save is in progress.

The preview renders up to 100 lines per page, with Previous / Next and **Go to line** for longer files. It uses the existing 1 MiB file-editor read limit; if a file cannot be previewed, manual ranges remain available.

**Back** retains an unsaved selection in memory for a return visit to the same file and project. **Cancel** asks before discarding changes. Drafts contain only paths and line numbers, not file content; they do not survive a reload, which warns while an editor has unsaved changes. To stop hiding a file, remove its ranges and save; removing all saved ranges requires confirmation.

### Protection limits

This is **not a security boundary**. Only `read_file` and `search_files` are filtered. Shell, MCP, and other access can still read the original content. These limits are visible on the list and editor, not hidden in a help popup. Rules track line numbers, not text, so review them after editing or moving file content.

```text
# Settings → Project → More settings → Hide file content
src/secrets.js  →  hide lines 1-1 and 3-3
```

After saving, a `read_file` call on that file returns the hidden lines replaced by a marker:

```text
# File: src/secrets.js
# Lines: 1-4

[hidden]
const normal = 1;
[hidden]
```

And a `search_files` call for text that only appears on a hidden line returns no matches for that line.

### Behavior

- Rules are stored per project under `hideFileContent` in `.mouaif.json` (or the DB-backed project row). Shape:
  ```json
  {
    "hideFileContent": [
      { "path": "src/secrets.js", "ranges": [ { "start": 1, "end": 1 }, { "start": 3, "end": 3 } ] }
    ]
  }
  ```
- Each range is 1-indexed and inclusive (`start` and `end` may be equal for a single line). A malformed range (start below 1, or end below start) is dropped on save; an entry with no valid ranges is dropped.
- Only `read_file` and `search_files` are redacted. `list_files` returns paths (no content), and `write_file` / `edit_file` modify the on-disk file rather than expose it, so they are unchanged.
- The redaction applies to whole-file reads **and** to `startLine` / `endLine` slices. Slices retain their original line offset when checking rules, so a hidden range cannot be recovered by requesting a sub-window. In-process regression coverage: `node scripts/test-hide-file-slices.js`.
- The replacement keeps the newline structure intact, so line numbers and the total line count are identical to the real file.
- The on-disk file is untouched; removing a rule restores full visibility immediately.

## Implementation notes

- New module: [src/hideFileContent.js](../../src/hideFileContent.js) — loads, normalizes, and queries the rules. Every read is best-effort: a missing project, malformed rule, or unreadable settings store makes the tools behave as if no redaction were configured.
- [src/tools/files.js](../../src/tools/files.js) — `runReadFile` redacts the body via `redactText`; `runSearchFiles` skips hidden lines via `lineIsHidden`.
- REST surface: `GET /api/settings/hide-file-content?projectDir=<abs>` returns the normalized rules; `PUT /api/settings/hide-file-content` with `{ projectDir, rules }` stores them. Both live in [src/server-handlers-settings.js](../../src/server-handlers-settings.js).
- Frontend route `#/settings/project/hide?projectDir=<dir>` renders the lazily loaded [SettingsHiddenContent.jsx](../../frontend/src/components/SettingsHiddenContent.jsx). Adding `&file=<project-relative-path>` opens [HiddenContentEditor.jsx](../../frontend/src/components/settings/HiddenContentEditor.jsx); caller context is preserved. The picker reuses [AgentFilePicker.jsx](../../frontend/src/components/AgentFilePicker.jsx) with contextual labels.
- The preview uses the existing owner-facing `GET /api/file?projectDir=<dir>&path=<path>` endpoint. It is read-only: the editor never calls `PUT /api/file` or sends file content to the model. Redaction saves still use the existing settings endpoint.
- Mobile-first: one column, a separate editor instead of a nested settings card, wrapped source lines, 44px-minimum controls, and a sticky safe-area-aware Save / Cancel footer. Selection is indicated by both color and a check mark, with pressed-state semantics and accessible source descriptions.
- The parent Project settings page derives its hidden-file count from the already-loaded project settings, independently of the dedicated editor’s state.
- Tests: `npm run test:hidden-content` covers parent-page initial/loaded rendering, hidden-file counts, sibling pages, range operations, routing, failure/retry and draft behavior. `node scripts/test-hidden-content-ui.mjs` starts a time-limited isolated browser fixture with a fake API for mobile, paging, and failure tests; open `#/settings/project` to test the parent-page round trip. Neither writes real project settings.

## Related

- Native file tools: [docs/features/file-tools.md](./file-tools.md).
- Tool authorization: [docs/features/tool-authorization.md](./tool-authorization.md).
- Project settings storage: [docs/features/project-settings-storage.md](./project-settings-storage.md).
