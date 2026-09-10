# Hide file content

## Overview

Per-project settings page that marks specific lines or character ranges of a source file as hidden from the agent file tools. When the model calls `read_file` the hidden lines or characters come back as `[hidden]`, and `search_files` silently skips any match that lands inside a hidden range or character span. The on-disk file is never modified, so the redaction stays purely on the model-facing side.

## Usage

Open **Settings → This project → More settings → Hide file content**, or navigate directly to `#/settings/project/hide`.

1. Tap **+ Add file**, or tap a saved file row to edit it.
2. The file opens in the real CodeMirror text editor (**Select hidden content**, dark theme, line numbers, syntax highlighting) with the original content. It is **read-only** — the text cannot be edited, only marked.
3. **Whole-line hiding** — tap a line number in the toggle gutter (the column left of the text) to hide that line; tap it again to show it. Hidden lines get a highlighted background and a ✓ in the gutter. Each gutter cell is exactly as tall as the line it belongs to and 2rem wide, so a tap always lands on the line you aimed at.
4. **Character-range hiding** — drag to select text inside the editor. The status bar updates with the column range, and **Hide selected text** in the sticky footer becomes enabled. Tap it to mark that span; tap it again with the same selection to clear it. A span on a single line hides the exact columns; a span that crosses line breaks hides the full middle lines plus the boundary columns.
5. For larger whole-line selections, expand **Enter line ranges manually** and enter inclusive **From** / **To** numbers. Invalid values are explained rather than silently changed. Adjacent and overlapping ranges are merged on save; the same is done for character spans.
6. Tap **Save**. Every action (hide selection, cancel, save) lives in the sticky footer, so it stays reachable and tappable no matter how far the editor or the manual ranges scroll. The editor returns to the file list only after saving succeeds. A failed save keeps the selection available for retry, and controls are disabled while a save is in progress.

### Removing a hiding

Every file row on the list carries its own **Remove** action, so a file can be un-hidden without opening the editor:

| Goal | Action |
| --- | --- |
| Un-hide one saved line | Tap the line number again in the editor gutter, then **Save**. |
| Un-hide one saved manual range | **Enter line ranges manually** → **×** on that row → **Save**. |
| Un-hide selected text | Re-select the same span and tap **Hide selected text** again (an exact match removes it). |
| Un-hide a whole file | Tap **Remove** on its row and confirm **Stop hiding content in `<path>`?** |
| Un-hide everything | Remove each row, or clear the selection in every editor. |

- **Remove** writes the whole rule set back without that file's entry; the row disappears and a status line reports `` `<path>` is no longer hidden. `` Nothing is written until the confirmation is accepted, and a declined confirmation leaves the list untouched.
- A failed write keeps every row, re-enables the controls, and says so: *"Nothing changed; the file is still hidden."* The action can be retried immediately.
- One write at a time: while a removal is in flight the row shows **Removing…** and all remove controls are disabled, so a double tap cannot queue a second write.
- Removal is available to whoever can open project settings; it is the same endpoint the editor uses. The on-disk file is never touched, so un-hidden content is visible to the agent file tools on the very next call.
- Keyboard focus moves to the next row's **Remove** (or **+ Add file** when the list empties) after a successful removal, so the tapped control disappearing never drops focus on the page body.

### Button layout

The footer is the only interactive band: it is `position: sticky; bottom: 0` and owns every control of this view. The editor and its help line scroll underneath it, and the footer — not the content — wins taps in that band.

```text
┌─────────────────────────────┐
│ editor (read-only, scrolls) │
│ …help line (non-interactive)│
├─────────────────────────────┤  ← sticky footer starts here
│ [Hide selected text]  Cancel Save │
└─────────────────────────────┘
```

Do not move an action back into the editor body: a control rendered outside the footer can overlap the footer band and swallow taps meant for Cancel/Save.
The preview uses the existing 1 MiB file-editor read limit; if a file cannot be previewed, manual ranges remain available.

**Back** retains an unsaved selection in memory for a return visit to the same file and project. **Cancel** asks before discarding changes. Drafts contain only paths and ranges, not file content; they do not survive a reload, which warns while an editor has unsaved changes. To stop hiding a file, remove its ranges and save; removing all saved ranges and characters requires confirmation.

### Protection limits

This is **not a security boundary**. Only `read_file` and `search_files` are filtered. Shell, MCP, and other access can still read the original content. These limits are visible on the list and editor, not hidden in a help popup. Rules track line numbers and column positions, not text, so review them after editing or moving file content.

```text
# Settings → Project → More settings → Hide file content
src/secrets.js  →  Lines 3 · Text on line 1, cols 18–25
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

### Labels

Every summary label comes from one helper, `describeHidden({ ranges, chars })`, so the list and the editor can never disagree about what is hidden:

| Hidden content | Label |
| --- | --- |
| lines only | `Lines 3–5` |
| selected text only | `Text on line 8, cols 4–9` |
| selected text across lines | `Text on lines 4–7` |
| lines and text | `Lines 3–5 · Text on line 8, cols 4–9` |
| nothing | file list: `Nothing hidden yet…`; editor: `Tap a line number, or select text and tap Hide selected text.` |

- A rule that hides only characters is labelled as text, never as lines, so no row ever reads "No lines selected".
- Overlapping spans on the same line are merged before they are labelled, and several spans are separated with `;`.
- The editor footer repeats the label under the count line (`1 line, 1 text span`) and keeps showing `Fix the range values to continue.` while a manual range is invalid.

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
- Each list row is two controls in one `li`: the wide `button.hidden-content__file` (open the editor) and `button.hidden-content__remove` (**Remove**, colour `var(--danger)`, its own 44px target, `aria-label` = `Stop hiding content in <path>`). Removal reuses the same `PUT /api/settings/hide-file-content` call as `onSave` with the entry filtered out; there is no separate delete endpoint. `removing` holds the path in flight, `removeError` reports a failure next to the list without clearing it (the load-failure `error` state would replace the whole list), and focus moves to the next row's remove control — or `+ Add file` — through `requestAnimationFrame` after the list re-renders.
- Labels: `describeHidden({ ranges, chars })` in [hiddenRanges.js](../../frontend/src/components/settings/hiddenRanges.js) is the single source of the row and footer summary (`Lines 3–5 · Text on line 8, cols 4–9`, `Text on lines 4–7`, `Nothing hidden`). It normalizes the spans first, so overlapping selections merge before they are labelled, and it is the reason a character-only rule is never summarised as "No lines selected". `SettingsHiddenContent.jsx` calls it per file row; `HiddenContentEditor.jsx` calls it for the footer detail and swaps in `Tap a line number, or select text and tap Hide selected text.` while nothing is selected.
- The editor reuses the same CodeMirror runtime the `FileEditor` modal uses (`@codemirror/state` + `@codemirror/view`, `oneDark`), loaded as its own lazy chunk. It mounts an `EditorView` with `EditorState.readOnly.of(true)`, which keeps `contenteditable` on the content DOM so touch text selection keeps working (CodeMirror's read-only facet blocks the edit pipeline, not selection). It adds a custom **toggle gutter** via `gutter()`: a `GutterMarker` per line renders ✓ when hidden / + when not, `lineMarkerChange` rebuilds when rules change, and `domEventHandlers.click` toggles the line through `toggleLine`. Two `StateEffect`+`StateField` pairs carry the whole-line list and the character-span list into the editor so the gutter and the two highlights (`.hc__line-hidden` and `.hc__char-hidden`) stay in sync with React state without re-creating the view. Each gutter element is sized by CodeMirror to its own line block (about 20px per unwrapped line, taller for wrapped lines) and is 2rem wide, so it aligns exactly with the line it toggles; the editor scrolls inside its 48dvh box instead of paging.
- The selection is reported to React from two sources, both funnelled through one `reportSelection()` in `HiddenContentEditor.jsx`: an `EditorView.updateListener` (the editor state) and a document `selectionchange` listener that maps the browser's own DOM range through `view.posAtDOM` (`domSelectionSpan`). CodeMirror only mirrors a native selection into its state while the content DOM is focused, and a long-press selection on a phone does not always leave it focused, so the DOM range wins whenever it is non-empty and inside the editor; the editor state is the fallback. Both paths build the span with the same `spanFromPositions` helper, so they can never disagree about the columns.
- **Hide selected text** (in the sticky footer) calls `toggleChar(chars, span)` to add or remove the span, and the editor's `charDecorations` re-renders the inline highlight on the next dispatch. It acts on `pointerdown`: on touch the same tap dismisses the active selection and a browser may swallow the click that follows, which used to leave the highlighted text unhidden. The `onClick` path stays for keyboard and assistive-technology activation and skips a click that a `pointerdown` already handled (timestamp guard), so a mouse tap never toggles twice. The button is disabled when there is no selection, when the form is saving, or when the preview is loading.
- The extra `selectionchange` listener is removed in the engine's `destroy()` (the component calls that instead of `view.destroy()`), so navigating away never leaks a document-level listener.
- Manual range editing remains and is the fallback when the preview fails. Editor and manual edits share one `ranges` state, so a form value change immediately updates the gutter and highlight. Char spans share one `chars` state likewise.
- The preview uses the existing owner-facing `GET /api/file?projectDir=<dir>&path=<path>` endpoint. It is read-only: the editor never calls `PUT /api/file` or sends file content to the model. Redaction saves still use the existing settings endpoint.
- Mobile-first: one column, a separate editor instead of a nested settings card, wrapped source lines, 44px-minimum controls, and a sticky safe-area-aware footer that holds every action (**Hide selected text** / Cancel / Save) so none of them can be covered by the scrolled content. Selection is indicated by both color and a check mark, with pressed-state semantics and accessible source descriptions.
- The parent Project settings page derives its hidden-file count from the already-loaded project settings, independently of the dedicated editor’s state.
- Tests: `npm run test:hidden-content` covers parent-page initial/loaded rendering, hidden-file counts, sibling pages, range operations, char-span merge/containment/toggle, routing, failure/retry and draft behavior. `scripts/test-hidden-content-list.mjs` pins the list contracts: `describeHidden` unit cases (lines only, text only, multi-line text, both, merged and repeated spans, invalid spans, nothing) plus a render of `SettingsHiddenContentView` asserting the file-row labels, that a char-only row never reads "No lines selected", and the whole row-removal flow — labelled control per row, declined confirmation writes nothing, the PUT body keeps every other rule, a failed write keeps the row and reports the status, a retry succeeds and clears the message, and a tap during an in-flight write neither queues nor duplicates a request. `scripts/test-hidden-content-editor.mjs` also asserts the layout contract that keeps the buttons tappable: the render puts **Hide selected text**, Cancel and Save inside the sticky footer, and the hide action is `type="button"` so it can never submit the form. `node scripts/test-hide-file-char-spans.js` exercises `normalizeCharSpan`, `matchIsHidden` with and without columns, `read_file` redaction on single- and multi-line spans, and `search_files` column filtering. `node scripts/test-hidden-content-ui.mjs` starts a time-limited isolated browser fixture with a fake API for mobile, paging, and failure tests; open `#/settings/project` to test the parent-page round trip. None of these write real project settings.

## Related

- Native file tools: [docs/features/file-tools.md](./file-tools.md).
- Tool authorization: [docs/features/tool-authorization.md](./tool-authorization.md).
- Project settings storage: [docs/features/project-settings-storage.md](./project-settings-storage.md).
