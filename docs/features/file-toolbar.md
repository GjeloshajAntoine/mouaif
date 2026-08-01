# File toolbar

The file toolbar sits as a round button next to the chat composer text box. It opens a dropdown menu with exactly two actions: **Files** (the project file editor) and **Git** (a full-screen git changes modal).

## Overview

A single trigger button (folder + chevron SVG icon) next to the textarea opens a dropdown menu:

- **Files** — opens the CodeMirror-based project file editor popup.
- **Git** — opens a modal that shows the project's git state: staged changes, unstaged changes, and recent commits. Every section and every file row is collapsible; each changed file expands into its diff.

The git actions that previously lived in the dropdown (status / diff / log / add / commit) are gone — they are replaced by the modal, which shows the same information in a browsable, expandable form. Mutating git actions (add, commit) are intentionally not exposed from the composer; the modal is read-only.

## Usage

Tap the arrow button next to the text box to expand the menu:

| Item | Action |
|------|--------|
| Files | Opens the existing in-app CodeMirror editor for the project |
| Git | Opens the git changes modal |

### Git modal

The modal has three collapsible sections:

1. **Staged changes** — files in the index (status `M`, `A`, `D`, `R`, `C`, …), each expandable to its `git diff --cached` output.
2. **Unstaged changes** — working-tree modifications, each expandable to its `git diff` output. Untracked files are listed but have no diff (no baseline).
3. **Recent commits** — the last 20 commits (`git log --oneline -20`). Each commit expands into its changed files; each file expands into the diff for that commit.

Tap a section header to collapse/expand it, tap a file row to show/hide its diff. The header shows the current branch name; a refresh button re-fetches the data.

## Backend API

### `GET /api/git/info?projectDir=<abs>`

Returns parsed, machine-readable git state (no raw shell output):

```json
{
  "ok": true,
  "branch": "master",
  "staged": [
    { "path": "src/a.js", "status": "M", "statusText": "Modified", "diff": "diff --git a/src/a.js b/src/a.js\n…" }
  ],
  "unstaged": [
    { "path": "notes.md", "status": "?", "statusText": "Untracked", "diff": "" }
  ],
  "commits": [
    {
      "hash": "8bb48502df3ceb032fa94d259837caf70c5db115",
      "short": "8bb4850",
      "subject": "fix: compact MCP server rows",
      "author": "mouaif",
      "date": "2026-07-31T16:40:00+02:00",
      "files": [
        { "path": "src/web/src/components/settings/…", "status": "M", "statusText": "Modified", "diff": "diff --git …" }
      ],
      "filesTruncated": false
    }
  ],
  "truncated": { "stagedFiles": false, "unstagedFiles": false }
}
```

Implementation details:

- Parsed from `git status --porcelain=v1 -z` (NUL-separated records, rename targets consumed), `git symbolic-ref --short HEAD`, `git log -20 --format=%H%x00%h%x00%s%x00%an%x00%aI%x00 --`, and per-file `git diff --cached -- <path>` / `git diff -- <path>`.
- Per-commit files are parsed from `git show --format=<hash>` output.
- Diffs are capped at 120 lines each; per-section diffs are fetched for the first 12 files, commit diffs for the first 3 commits (flags in `truncated` / `filesTruncated`).
- `ok: false` with `code: 'ENOGIT'` is returned when the project is not a git repository.

The older `POST /api/git` endpoint (status / diff / log / add / commit / branch / checkout / stash) is unchanged and still available for scripts.

## Implementation notes

- File: `src/web/src/components/chat/FileToolbar.jsx` (component — menu with Files + Git)
- File: `src/web/src/components/chat/GitModal.jsx` (component — the modal)
- File: `src/web/src/components/chat/Chat.jsx` (integration — toolbar next to composer)
- File: `src/web/src/chat-composer.css` (CSS — `.file-toolbar*` and `.gm__*` classes)
- File: `src/index.js` (backend — `GET /api/git/info` handler)

The toolbar is a stateless Preact component that receives `projectDir` and `onOpenFileEditor` as props. The git modal owns its own fetch state (loading / error / retry) and collapses each section, file, and commit independently.

The trigger icon is a stacked pair of inline SVGs: a folder (Files) with a small down-chevron (menu) beneath it, rendered with `fill: currentColor` like every other icon in the app. Earlier attempts used `▲`/`▼` text glyphs (U+25B2/U+25BC), which render as color emoji on some mobile fonts and collapse into a single visible icon, and a single 14px two-triangle SVG, which was too small to read as two icons. The folder + chevron at 18×14 + 12×6 with a 2px gap shows both icons clearly on every device.
