# File toolbar

The file toolbar sits as a round button next to the chat composer text box. It opens a dropdown menu with three actions: **Files** (the project file editor), **Git** (a full-screen git modal), and **Cli** (an interactive command prompt running in the project directory).

## Overview

A single trigger button (folder icon with an up-chevron above and a down-chevron below) next to the textarea opens a dropdown menu:

- **Files** — opens the CodeMirror-based project file editor popup.
- **Git** — opens a modal with a header and a body. The header holds a **branch dropdown**, **Pull** (shows behind count badge), **Push** (shows ahead count badge), refresh, and close. The body shows four collapsible sections: **Stash** (with a **Stash up** button plus Apply / Pop / Drop per stash entry), **Staged changes**, **Unstaged changes**, and **Recent commits** (paginated — load more via `GET /api/git/commits`). Every file row and commit is collapsible; each changed file expands into its diff.
- **Cli** — opens a full-screen terminal that runs commands in the project directory (the default working path). Output streams live over SSE.

The git actions that previously lived in the dropdown (status / diff / log / add / commit) are gone — they are replaced by the modal, which shows the same information in a browsable, expandable form. The modal is read-only except for the header controls (branch checkout, push, pull) and the stash section (apply / pop / drop).

## Usage

Tap the arrow button next to the text box to expand the menu:

| Item | Action |
|------|--------|
| Files | Opens the existing in-app CodeMirror editor for the project |
| Git | Opens the git modal |
| Cli | Opens the interactive command prompt session |

### Git modal

The modal header has no title — the branch name is the primary element, shown as a dropdown so you can switch branches (a checkout) from the header itself. Next to it are **Pull** and **Push** buttons — each shows a red badge with the behind/ahead count when the branch diverges from its upstream. A refresh button and close button complete the header.

Below the header are four collapsible sections (Stash first):

- **Stash** — the stash list, at the top of the body. A **Stash up** button at the top creates a new stash (`git stash`). Each stash entry has **Apply**, **Pop**, and **Drop** actions.
- **Staged changes** — files staged with `git add`, each expanding into its cached diff.
- **Unstaged changes** — modifications to tracked files.
- **Recent commits** — the most recent commits (20 on first load). Tap **Load more** at the bottom to fetch the next 20, backed by `GET /api/git/commits?projectDir=...&offset=N&count=20`.

A transient notice bar under the header shows the result of push / pull / checkout / stash operations (success or the raw git stderr).

### CLI prompt

The Cli item opens a full-screen overlay with a live terminal readout. The default working directory is the **project root** — type a command and press Enter to run it there. On Windows the shell is the classic **Command Prompt (`cmd.exe`)** (honoring `ComSpec`); on POSIX it is `$SHELL` or `/bin/sh`.

Output streams in as the command runs; the prompt line stays at the bottom and re-focuses after each command. The header shows the shell label and the project path. The session closes when you tap the × button, press Escape, or leave the chat.

Note: the session is a **piped** (non-TTY) child process, so interactive programs (REPLs, prompts that read from a terminal) will not work — the same limitation as the model-facing `shell` tool. Non-interactive commands behave like a real Command Prompt.

## Backend API

`GET /api/git/info?projectDir=<abs>` returns `branch`, `branches` (local + remote), `ahead`/`behind` (counts against upstream), `stashes` (each `{ index, subject, date }`), `staged`, `unstaged`, and the first 20 `commits` (see [src/server-handlers-git.js](../../src/server-handlers-git.js)).

`GET /api/git/commits?projectDir=<abs>&offset=0&count=20` returns paginated commits with `{ ok, commits, total, offset, count }`. The first page (offset=0) includes per-commit diffs; subsequent pages return only commit metadata.

`POST /api/git` accepts `{ projectDir, action, args?, message? }`. Actions: `status`, `diff`, `log`, `add`, `commit`, `branch`, `checkout`, `stash`, `stash-apply`, `stash-pop`, `stash-drop`, `push`, `pull`.

### `GET /api/tools/cli/session?projectDir=<abs>`

Starts (or reuses) the persistent CLI session for a project and returns its id:

```json
{
  "id": "cli_lx3k2p",
  "projectDir": "C:\\Users\\me\\myproject",
  "shell": "Command Prompt (cmd.exe)",
  "startedAt": 1755000000000,
  "defaultDir": "C:\\Users\\me\\myproject"
}
```

### `POST /api/tools/cli/command`  body: `{ projectDir, cmd }`

Writes one command to the session's stdin. The session stays open.

### `POST /api/tools/cli/close`  body: `{ projectDir }`

Kills the session (idempotent).

Output rides the existing `GET /events` SSE channel as `cli_output` frames:

```json
{ "id": "cli_lx3k2p", "stream": "stdout", "data": "hello" }
{ "id": "cli_lx3k2p", "stream": "stderr", "data": "warning" }
{ "id": "cli_lx3k2p", "stream": "exit",  "data": "0" }
```

## Implementation notes

- File: `frontend/src/components/chat/FileToolbar.jsx` (component — menu with Files + Git + Cli)
- File: `frontend/src/components/chat/GitModal.jsx` (component — the modal)
- File: `frontend/src/components/chat/CliModal.jsx` (component — the CLI terminal modal)
- File: `frontend/src/components/chat/Chat.jsx` (integration — toolbar next to composer)
- File: `frontend/src/chat-composer.css` (CSS — `.file-toolbar*`, `.gm__*`, and `.cli__*` classes)
- File: `src/server-handlers-tools.js` (backend — CLI session + command + close handlers)
- File: `src/server-shared.js` (backend — `broadcast` reused for `cli_output` frames)

The toolbar is a stateless Preact component that receives `projectDir` and `onOpenFileEditor` as props. The git and CLI modals each own their fetch/SSE state (loading / error / retry) and collapse/expand independently. Both modals are **lazy-loaded**: `FileToolbar.jsx` holds a `useEffect` per modal that calls `import('./GitModal.jsx')` / `import('./CliModal.jsx')` only when that modal is first opened (mirroring how `Chat.jsx` lazy-loads the file editor). Vite emits them as separate chunks (`GitModal-*.js`, `CliModal-*.js`) with no `modulepreload` hint in `index.html`, so the browser fetches them only when the user opens the modal, not at page load. On mobile, all three full-screen overlays apply `--safe-top` and `--safe-bottom` padding because fixed overlays sit outside the app shell's safe-area padding; this keeps their headers below the device status bar and their content above the home indicator. The file editor's path field is the only flexible header item and is allowed to shrink to zero, ensuring the back, go, refresh, and close controls remain visible even for long paths on narrow screens.

The CLI session is a single persistent child process per project (`windowsHide` on Windows, no window shown), keyed by the resolved project directory. Child processes are reaped on server exit via an exit hook, mirroring the native `shell` tool. The trigger icon is a stack of three inline SVGs: an up-chevron, the folder in the middle, and a down-chevron, all rendered with `fill: currentColor` like every other icon in the app. Each element is a separate SVG (folder 18×14, chevrons 12×6) with 2px gaps, so all three are clearly visible. Earlier attempts used `▲`/`▼` text glyphs (U+25B2/U+25BC), which render as color emoji on some mobile fonts and collapse into a single visible icon, and a single 14px two-triangle SVG, which was too small to read as two icons.