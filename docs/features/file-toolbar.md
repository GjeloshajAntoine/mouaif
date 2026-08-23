# File toolbar

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
- **Unstaged changes** — modifications to tracked files plus untracked files that have not yet been added. Untracked entries are labeled **Untracked** and appear without a diff because they have no committed baseline.
- **Recent commits** — the most recent commits (20 on first load). Tap **Load more** at the bottom to fetch the next 20, backed by `GET /api/git/commits?projectDir=...&offset=N&count=20`. Expanding a commit fetches its full changed-file list on demand via `GET /api/git/commit-files?projectDir=...&hash=...` (no 3-commit or diff-line caps — every file in the commit is listed).

A transient notice bar under the header shows the result of push / pull / checkout / stash operations (success or the raw git stderr).

### CLI prompt

The Cli item opens a full-screen overlay with a live terminal readout. The default working directory is the **project root** — type a command and press Enter to run it there. On Windows the shell is the classic **Command Prompt (`cmd.exe`)** (honoring `ComSpec`); on POSIX it is `$SHELL` or `/bin/sh`.

Output streams in as the command runs; the prompt line stays at the bottom and re-focuses after each command. The header shows the shell label and the project path. The session closes when you tap the × button, press Escape, or leave the chat.

Note: the session is a **piped** (non-TTY) child process, so interactive programs (REPLs, prompts that read from a terminal) will not work — the same limitation as the model-facing `shell` tool. Non-interactive commands behave like a real Command Prompt.
