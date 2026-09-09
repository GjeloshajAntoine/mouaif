# Hide file content

## Overview

Per-project settings page that marks specific line ranges of a source file as hidden from the agent file tools. When the model calls `read_file` the hidden lines come back as `[hidden]`, and `search_files` silently skips any match on a hidden line. The on-disk file is never modified, so the redaction stays purely on the model-facing side.

## Usage

Open **Settings → This project → More settings → Hide file content**, or navigate directly to `#/settings/project/hide`. Pick a file from the project (the same browser the chat file editor uses), add one or more 1-indexed inclusive line ranges, and save.

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
- Frontend route `#/settings/project/hide` renders inside [frontend/src/components/SettingsProject.jsx](../../frontend/src/components/SettingsProject.jsx); the file-picker overlay is the existing [AgentFilePicker.jsx](../../frontend/src/components/AgentFilePicker.jsx).
- Mobile-first: the page is a single column of stacked cards with a full-height tap target for each line-range "remove" button and a `+ Add range` / `+ Add file` action, following the settings layout.

## Related

- Native file tools: [docs/features/file-tools.md](./file-tools.md).
- Tool authorization: [docs/features/tool-authorization.md](./tool-authorization.md).
- Project settings storage: [docs/features/project-settings-storage.md](./project-settings-storage.md).
