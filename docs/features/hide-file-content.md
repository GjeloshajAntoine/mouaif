# Hide file content

## Overview

Per-project settings page that marks specific lines or character ranges of a source file as hidden from the agent file tools. When the model calls `read_file` the hidden lines or characters come back as `[hidden]`, and `search_files` silently skips any match that lands inside a hidden range or character span. The on-disk file is never modified, so the redaction stays purely on the model-facing side.

## Usage

Open **Settings → This project → More settings → Hide file content**, or navigate directly to `#/settings/project/hide`.

1. Tap **+ Add file**, or tap a saved file row to edit it.
2. The file opens in the real CodeMirror text editor (dark theme, line numbers, syntax highlighting) with the original content. It is **read-only** — the text cannot be edited, only marked.
3. **Whole-line hiding** — tap a line number in the toggle gutter (the column left of the text) to hide that line; tap it again to show it. Hidden lines get a highlighted background and a ✓ in the gutter. The gutter has a 44px-minimum tap target per line.
4. **Character-range hiding** — drag to select text inside the editor. The status bar updates with the column range, and **Hide selected text** becomes enabled. Tap it to mark that span; tap it again with the same selection to clear it. A span on a single line hides the exact columns; a span that crosses line breaks hides the full middle lines plus the boundary columns.
5. For larger whole-line selections, expand **Enter line ranges manually** and enter inclusive **From** / **To** numbers. Invalid values are explained rather than silently changed. Adjacent and overlapping ranges are merged on save; the same is done for character spans.
6. Tap **Save**. The editor returns to the file list only after saving succeeds. A failed save keeps the selection available for retry, and controls are disabled while a save is in progress.
The preview uses the existing 1 MiB file-editor read limit; if a file cannot be previewed, manual ranges remain available.

**Back** retains an unsaved selection in memory for a return visit to the same file and project. **Cancel** asks before discarding changes. Drafts contain only paths and ranges, not file content; they do not survive a reload, which warns while an editor has unsaved changes. To stop hiding a file, remove its ranges and save; removing all saved ranges and characters requires confirmation.

### Protection limits

This is **not a security boundary**. Only `read_file` and `search_files` are filtered. Shell, MCP, and other access can still read the original content. These limits are visible on the list and editor, not hidden in a help popup. Rules track line numbers and column positions, not text, so review them after editing or moving file content.

```text
# Settings → Project → More settings → Hide file content
src/secrets.js  →  hide lines 3-3 and chars 1:18-25
```

After saving, a `read_file` call on that file returns the hidden content replaced by a marker:

```text
# File: src/secrets.js
# Lines: 1-4

const apiKey = "[hidden]";
const normal = 1;
[hidden]
```

And a `search_files` call for text that falls only inside a hidden range or character span returns no match for that line, even when the rest of the line is visible.

### Behavior

- Rules are stored per project under `hideFileContent` in `.mouaif.json` (or the DB-backed project row). Shape:
  ```json
  {
    "hideFileContent": [
      {
        "path": "src/secrets.js",
        "ranges": [ { "start": 3, "end": 3 } ],
        "chars":  [ { "startLine": 1, "endLine": 1, "startCol": 18, "endCol": 25 } ]
      }
    ]
  }
  ```
- `ranges` is the existing 1-indexed inclusive whole-line set. `chars` is the new 1-indexed inclusive character-span set; it is optional and only present when at least one character span is stored. Older saved data without `chars` keeps working unchanged.
- A malformed range (start below 1, or end below start) is dropped on save; a malformed span (start below 1, end before start on a single line, non-integers) is dropped on save. An entry with no valid ranges and no valid spans is dropped entirely.
- Only `read_file` and `search_files` are redacted. `list_files` returns paths (no content), and `write_file` / `edit_file` modify the on-disk file rather than expose it, so they are unchanged.
- The redaction applies to whole-file reads **and** to `startLine` / `endLine` slices. Slices retain their original line offset when checking rules, so a hidden range cannot be recovered by requesting a sub-window. In-process regression coverage: `node scripts/test-hide-file-slices.js`.
- `search_files` skips a match when its column range overlaps any hidden character span on that line (or when the whole line is hidden by a `range`). In-process regression coverage: `node scripts/test-hide-file-char-spans.js`.
- The replacement keeps the newline structure intact, so line numbers and the total line count are identical to the real file. Character spans are replaced in place; the marker does not extend the line.
- The on-disk file is untouched; removing a rule restores full visibility immediately.

## Implementation notes

- New module: [src/hideFileContent.js](../../src/hideFileContent.js) — loads, normalizes, and queries the rules. Every read is best-effort: a missing project, malformed rule, or unreadable settings store makes the tools behave as if no redaction were configured.
- [src/tools/files.js](../../src/tools/files.js) — `runReadFile` redacts the body via `redactText` (which honors both `ranges` and `chars`); `runSearchFiles` skips a match whose column range overlaps a hidden character span, via `matchIsHidden`.
- REST surface: `GET /api/settings/hide-file-content?projectDir=<abs>` returns the normalized rules; `PUT /api/settings/hide-file-content` with `{ projectDir, rules }` stores them. Both live in [src/server-handlers-settings.js](../../src/server-handlers-settings.js). The persisted shape accepts both `ranges` and `chars` per entry.
- Frontend route `#/settings/project/hide?projectDir=<dir>` renders the lazily loaded [SettingsHiddenContent.jsx](../../frontend/src/components/SettingsHiddenContent.jsx). Adding `&file=<project-relative-path>` opens [HiddenContentEditor.jsx](../../frontend/src/components/settings/HiddenContentEditor.jsx); caller context is preserved. The picker reuses [AgentFilePicker.jsx](../../frontend/src/components/AgentFilePicker.jsx) with contextual labels.
- The editor reuses the same CodeMirror runtime the `FileEditor` modal uses (`@codemirror/state` + `@codemirror/view`, `oneDark`), loaded as its own lazy chunk. It mounts an `EditorView` with `EditorView.editable.of(false)` — the **editable** facet (not `EditorState.readOnly`, which also blocks selection in CodeMirror 6) — so users can drag-select text without being able to type. It adds a custom **toggle gutter** via `gutter()`: a `GutterMarker` per line renders ✓ when hidden / + when not, `lineMarkerChange` rebuilds when rules change, and `domEventHandlers.click` toggles the line through `toggleLine`. Two `StateEffect`+`StateField` pairs carry the whole-line list and the character-span list into the editor so the gutter and the two highlights (`.hc__line-hidden` and `.hc__char-hidden`) stay in sync with React state without re-creating the view. The gutter gives each line a 44px-minimum tap target; the editor is scrolled by CodeMirror, so no manual paging is needed.
- An `EditorView.updateListener` reports the current selection to React through `selectionInfo(view)`; **Hide selected text** in the editor toolbar (or in `onHideSelection` in `HiddenContentEditor.jsx`) calls `toggleChar(chars, sel.span)` to add or remove the span, and the editor's `charDecorations` re-renders the inline highlight on the next dispatch. The button is disabled when there is no selection, when the form is saving, or when the preview is loading.
- Manual range editing remains and is the fallback when the preview fails. Editor and manual edits share one `ranges` state, so a form value change immediately updates the gutter and highlight. Char spans share one `chars` state likewise.
- The preview uses the existing owner-facing `GET /api/file?projectDir=<dir>&path=<path>` endpoint. It is read-only: the editor never calls `PUT /api/file` or sends file content to the model. Redaction saves still use the existing settings endpoint.
- Mobile-first: one column, a separate editor instead of a nested settings card, wrapped source lines, 44px-minimum controls, and a sticky safe-area-aware Save / Cancel footer. Selection is indicated by both color and a check mark, with pressed-state semantics and accessible source descriptions.
- The parent Project settings page derives its hidden-file count from the already-loaded project settings, independently of the dedicated editor’s state.
- Tests: `npm run test:hidden-content` covers parent-page initial/loaded rendering, hidden-file counts, sibling pages, range operations, char-span merge/containment/toggle, routing, failure/retry and draft behavior. `node scripts/test-hide-file-char-spans.js` exercises `normalizeCharSpan`, `matchIsHidden` with and without columns, `read_file` redaction on single- and multi-line spans, and `search_files` column filtering. `node scripts/test-hidden-content-ui.mjs` starts a time-limited isolated browser fixture with a fake API for mobile, paging, and failure tests; open `#/settings/project` to test the parent-page round trip. None of these write real project settings.

## Related

- Native file tools: [docs/features/file-tools.md](./file-tools.md).
- Tool authorization: [docs/features/tool-authorization.md](./tool-authorization.md).
- Project settings storage: [docs/features/project-settings-storage.md](./project-settings-storage.md).
