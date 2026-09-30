# Grouped file reads and edits

## Overview

`read_files` and `edit_files` let the assistant read several files or apply several block replacements in one call. Both appear under **File tools** in chat tools, project settings, and agent tool selection, alongside the single-file tools.

## Usage

The tools inherit File tools authorization (**Off**, **Ask**, or **Allow**). With an allowlist, every target path must match before a group runs without approval. Each grouped tool can also be disabled individually.

### Read a group

Call `read_files` with a `files` array. Each entry accepts the same `path`, `startLine`, and `endLine` arguments as `read_file`; ranges are 1-indexed and inclusive.

```json
{
  "files": [
    { "path": "src/index.js", "startLine": 1, "endLine": 80 },
    { "path": "README.md" }
  ]
}
```

Images are attached as image parts, not base64 text. Hidden-content rules apply to each text read. A group accepts 1–50 entries and at most 2 MiB of returned text/image bytes; larger entries return a per-file cap error. Existing single-file caps still apply.

### Edit a group

Read the relevant regions first, then call `edit_files` with an `edits` array. Each entry takes `path` (or the compatibility alias `file`), a non-empty `oldText`, and `newText`.

```json
{
  "edits": [
    { "path": "src/a.js", "oldText": "const enabled = false;", "newText": "const enabled = true;" },
    { "path": "src/b.js", "oldText": "const count = 1;", "newText": "const count = 2;" }
  ]
}
```

A group accepts 1–50 replacements. Entries run **in order**, so multiple edits to the same path see earlier successful edits. Matching, line-ending handling, indentation adjustment, and size limits are the same as `edit_file`.

**Groups are not all-or-nothing transactions.** A failed entry leaves its file unchanged for that entry and does not stop later entries; earlier successful edits remain applied. Retry only the failed entries. Each successful replacement uses the existing atomic per-file write. Cancellation prevents subsequent entries from executing, without undoing edits already applied.

### Results

Results contain ordered `results` entries with `path`, `ok`, and `result`, plus `succeededCount` and `failedCount`. The call reports failure if any entry failed, while retaining all successful results. Expanded cards stack each file's content, image, diff, or error; collapsed cards show success/failure counts. These previews also work in nested agent transcripts.

See also [Native file tools](./file-tools.md) and [Tool authorization](./tool-authorization.md).
