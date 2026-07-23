# File toolbar

The file toolbar replaces the inline toolbar buttons that were previously embedded inside the chat composer pill. It sits in a separate row **above** the composer, keeping the text input row compact.

## Overview

A single trigger button (file icon + arrow) opens a dropdown menu with two sections:

- **File editor** — opens the CodeMirror-based project file editor popup.
- **Git actions** — status, diff, log, add (with file-paths prompt), and commit (with message prompt).

Git results are rendered inline beneath the toolbar as a collapsible card showing stdout/stderr and the exit code.

## Usage

Tap the file icon (📁 ▼) to expand the menu:

| Item | Action |
|------|--------|
| File editor | Opens the existing in-app CodeMirror editor for the project |
| Status | `git status --short --branch` |
| Diff | `git diff --stat` |
| Log | `git log --oneline -20` |
| Add | Prompts for file paths, then runs `git add <paths>` |
| Commit | Prompts for a message, then runs `git commit -m "<msg>"` |

`Add` and `Commit` expand inline within the menu so you can type paths/message without leaving the dropdown.

## Backend API

### `POST /api/git`

**Body:**

```json
{
  "projectDir": "/abs/path/to/project",
  "action": "status | diff | log | add | commit | branch | checkout | stash",
  "args": "optional extra args (e.g. file paths for add)",
  "message": "commit message (required for commit)"
}
```

**Response:**

```json
{
  "ok": true,
  "stdout": "…",
  "stderr": "",
  "exitCode": 0
}
```

The backend does a simple `spawn('git', ['-C', projectDir, ...])` with `GIT_TERMINAL_PROMPT=0` to prevent interactive prompts. Only read-safe / explicit-save actions are allowed (no `push`, `pull`, `fetch`).

## Implementation notes

- File: `src/web/src/components/chat/FileToolbar.jsx` (component)
- File: `src/web/src/components/chat/Chat.jsx` (integration — replaced inline toolbar buttons)
- File: `src/web/src/chat.css` (CSS — `.file-toolbar*` and `.chat-view__composer-area` classes)
- File: `src/index.js` (backend — `POST /api/git` handler)

The toolbar is a stateless Preact component that receives `projectDir` and `onOpenFileEditor` as props. It manages its own menu and git-result state via `useState`.