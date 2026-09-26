# Hide file content

## Overview

Per-project settings page that marks specific lines or character ranges of a source file as hidden from the agent file tools. When the model calls `read_file` the hidden lines or characters come back as `[hidden]`, and `search_files` silently skips any match that lands inside a hidden range or character span. The on-disk file is never modified, so the redaction stays purely on the model-facing side.

## Usage

Open **Settings → This project → More settings → Hide file content**, or navigate directly to `#/settings/project/hide`.

1. Tap **+ Add file**, or tap a saved file row to edit it.
2. The file opens in the real CodeMirror text editor (dark theme, line numbers, syntax highlighting) with the original content. It is **read-only** — the text cannot be edited, only marked. The header shows the **file name as the title** and the containing directory beneath it, so the page title names the file instead of the screen.
3. **Whole-line hiding** — tap a line number in the gutter (the column left of the text) to hide that line; tap it again to show it. Hidden lines get a highlighted, struck-through background and their **line number is painted as a filled accent pill** — the gutter has no separate toggle column and no ✓ / + glyph, so the state never depends on a character few fonts render identically. Each gutter cell spans its whole (possibly wrapped) line and is at least 44 × 44 px, so a tap always lands on the line you aimed at.
4. **Character-range hiding** — drag to select text inside the editor. The status bar updates with the column range, and the leading footer button becomes enabled. It reads **Hide selection**, or **Show selection** when the current selection exactly matches a saved span (tap it again to clear that span). A span on a single line hides the exact columns; a span that crosses line breaks hides the full middle lines plus the boundary columns.
5. For larger whole-line selections, tap **Ranges** in the footer status row to open the **Line ranges** panel and enter inclusive **From** / **To** numbers. Invalid values are explained rather than silently changed. Adjacent and overlapping ranges are merged on save; the same is done for character spans.
6. Tap **Save**. Every action (hide selection, ranges, cancel, save) lives in the sticky footer, so it stays reachable and tappable no matter how far the editor or the ranges panel scroll. The editor returns to the file list only after saving succeeds. A failed save keeps the selection available for retry, and controls are disabled while a save is in progress.

### Removing a hiding

Every file row on the list carries its own **Remove** action, so a file can be un-hidden without opening the editor:

| Goal | Action |
| --- | --- |
| Un-hide one saved line | Tap the line number again in the editor gutter, then **Save**. |
| Un-hide one saved manual range | **Ranges** → **×** on that row → **Save**. |
| Un-hide selected text | Re-select the same span and tap **Show selection** again (an exact match removes it). |
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
│ file.js            ← header │
│ Tap a number / Select text  │
│ editor (read-only, scrolls) │
├─────────────────────────────┤  ← sticky footer starts here
│ 2 lines · Lines 1–2 · Unsaved   Ranges │
│ [Hide selection]  Cancel Save │
└─────────────────────────────┘
```

Do not move an action back into the editor body: a control rendered outside the footer can overlap the footer band and swallow taps meant for Cancel/Save.
The preview fills the flush main column and only the editor (or the ranges panel) scrolls, so the footer never moves; on a very short screen the page itself scrolls instead.
The preview uses the existing 1 MiB file-editor read limit; if a file cannot be previewed, the line-ranges panel opens automatically.

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
| nothing | file list: `Nothing hidden yet…`; editor: `Tap a line number, or select text.` |

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

## Related

- Native file tools: [docs/features/file-tools.md](./file-tools.md).
- Tool authorization: [docs/features/tool-authorization.md](./tool-authorization.md).
- Project settings storage: [docs/features/project-settings-storage.md](./project-settings-storage.md).
