# File toolbar

## Overview

A single trigger button (folder icon with an up-chevron above and a down-chevron below) next to the textarea opens a dropdown menu. Its visible circle is reduced to match the composer bar. The bright green added-line count sits in the upper-left of the folder glyph and the bright red deleted-line count in its lower-right. Both use a heavier glyph stroke, remain fully contained by the folder, and render without a text shadow for clearer contrast at their compact size.
- **Files** — opens the CodeMirror-based project file editor popup.
- **Preview** — prompts for a web URL and captures a screenshot in the Inspector debug Chrome, publishing it to the web-preview dock and full-screen viewer (the same `webpreview` tool the model uses, run directly by the user without a model round-trip).
- **Git** — opens a modal with a header and a body. The header holds a **branch dropdown**, **Pull** (shows behind count badge), **Push** (shows ahead count badge), refresh, and close. The body shows four collapsible sections: **Stash** (with a **Stash up** button plus Apply / Pop / Drop per stash entry), **Staged changes**, **Unstaged changes**, and **Recent commits** (paginated — load more via `GET /api/git/commits`). Every file row and commit is collapsible; each changed file expands into its diff.
- **Cli** — opens a full-screen terminal that runs commands in the project directory (the default working path). Output streams live over SSE.
- **Actions** — the project's saved custom actions (CLI commands or MCP tool calls, see [custom-actions.md](custom-actions.md)). Each row shows the action's label, its `@id`, and its kind (`MCP` / `CLI`). Tapping one runs it immediately through the same `POST /api/actions/:id/run` path the model-facing command uses, so it still respects the underlying Shell / MCP authorization gate. The list refreshes whenever the menu opens.
The git actions that previously lived in the dropdown (status / diff / log / add / commit) are gone — they are replaced by the modal, which shows the same information in a browsable, expandable form. The modal is a full working-tree client: besides the header controls (branch checkout, push, pull) and the stash section (apply / pop / drop), the **Staged** and **Unstaged** sections carry per-file actions. In Staged changes each row has an **Unstage** button and the section header holds a commit bar — a commit-message input plus a **Commit** button (disabled until something is staged). In Unstaged changes each row has a **Stage** button, and when both sections have entries a **Stage all** button appears between them.

## Usage

Tap the arrow button next to the text box to expand the menu. Its `+N` / `−N` indicators combine staged and unstaged text-line changes; binary changes are ignored. Counts refresh when the project changes, whenever the menu opens, and after closing the Git modal.

| Item | Action |
|------|--------|
| Files | Opens the existing in-app CodeMirror editor for the project |
| Preview | Asks for a URL, captures it with the Inspector Chrome, and shows the web-preview viewer |
| Git | Opens the git modal |
| Cli | Opens the interactive command prompt session |
| Actions | Runs the project's custom CLI/MCP actions (label + `@id` + kind per row) |

### Git modal

The modal header has no title — the branch name is the primary element, shown as a dropdown so you can switch branches (a checkout) from the header itself. Next to it are **Pull** and **Push** buttons — each shows a red badge with the behind/ahead count when the branch diverges from its upstream. A refresh button and close button complete the header.

Below the header are four collapsible sections (Stash first):

- **Stash** — the stash list, at the top of the body. A **Stash up** button at the top creates a new stash (`git stash`). Each stash entry has **Apply**, **Pop**, and **Drop** actions.
- **Staged changes** — files staged with `git add`, each expanding into its cached diff. Above the list sits the commit bar: type a message and tap **Commit** to commit exactly the staged files (`git commit -m <message>`). Each row has an **Unstage** button (`git reset -q HEAD -- <path>`) that moves the file back to unstaged.
- **Unstaged changes** — modifications to tracked files plus untracked files that have not yet been added. Untracked entries are labeled **Untracked** and appear without a diff because they have no committed baseline. Each row has a **Stage** button (`git add -- <path>`). When both sections have entries, a **Stage all** button between them stages every unstaged file in one tap.
- **Recent commits** — the most recent commits (20 on first load). Tap **Load more** at the bottom to fetch the next 20, backed by `GET /api/git/commits?projectDir=...&offset=N&count=20`. Expanding a commit fetches its full changed-file list on demand via `GET /api/git/commit-files?projectDir=...&hash=...` (no 3-commit or diff-line caps — every file in the commit is listed).

A transient notice bar under the header shows the result of push / pull / checkout / stash operations (success or the raw git stderr).

### CLI prompt

The Cli item opens a full-screen overlay with a live terminal readout. The default working directory is the **project root** — type a command and press Enter to run it there. On Windows the shell is the classic **Command Prompt (`cmd.exe`)** (honoring `ComSpec`); on POSIX it is `$SHELL` or `/bin/sh`.

Output streams in as the command runs; the prompt line stays at the bottom and re-focuses after each command. The header shows the shell label and the project path. The session closes when you tap the × button, press Escape, or leave the chat.

Note: the session is a **piped** (non-TTY) child process, so interactive programs (REPLs, prompts that read from a terminal) will not work — the same limitation as the model-facing `shell` tool. Non-interactive commands behave like a real Command Prompt.
Each command line is terminated with the platform's native line ending: **CRLF** (`\r\n`) on Windows/cmd.exe and **LF** (`\n`) on POSIX sh/bash. The session records its platform (`windows`) when it starts and picks the terminator per write. This matters — written CRLF to a POSIX shell makes the trailing carriage return part of the command token, so bash reports `$'ls\r': command not found`.

Because the session is a **piped, non-TTY** child, full-screen programs that draw a terminal (`htop`, `top`, `less`, `vim`) render their output as raw ANSI/VT control codes rather than updating a real screen. The modal decodes those escapes through the streaming **`CliScreen`** decoder in `frontend/src/components/chat/utils.js` (the older stateless `stripAnsi` is kept for one-shot blobs). `CliScreen` is stateful: it buffers in-flight escape sequences, models a text grid, honours cursor-positioning / erase / alternate-screen, and renders the *current* frame. That fixes two problems with per-chunk stripping — (1) a sequence split across SSE frame boundaries (e.g. `ESC[` ends one frame, `8;1H` starts the next) is consumed as one instead of leaking `[8;1H` / `[39;49m` garbage, and (2) a TUI redraw **replaces its frame in place** instead of appending a new copy of the whole screen on every refresh. Ordinary scrolling output still grows a real scrollback. The terminal auto-scrolls only while the user is pinned to the bottom; once they drag up to read history the view stops following, so a refresh never yanks it back down. The result is a best-effort plain-text snapshot (column layout is not reconstructed).
### Web preview
The Preview item opens a small overlay asking for a URL, then runs a capture immediately. The capture goes through `POST /api/tools/webpreview` (the same endpoint the web-preview viewer uses to re-capture), so it respects the project's `webpreview` authorization gate: in **Ask** mode the prompt closes and the standard authorization card appears; approving it retries the capture. The screenshot is published to the web-preview dock (and opens the full-screen viewer) via the same `webpreviewState.js` bridge the model-driven tool uses.
## Implementation notes
- Stage / unstage operate on the **source path** of a rename (`old -> new` splits on `->` and uses the first part), because `git add -- old` records the rename while adding the new name too would stage its content as a separate file. The array `files` body form (`{ projectDir, action, files: [...] }`) passes each path to git as its own argv element, so file names with spaces survive intact. `unstage` runs `git reset -q HEAD -- <path>`, which is compatible across git versions (git ≥2.23's `git restore --staged` would work too, but `reset` also handles the case where the index has no HEAD yet).
- `frontend/src/components/chat/PreviewUrlPrompt.jsx` renders the URL-entry overlay (`wp__prompt-sheet`, reusing the `.wp__overlay` / `.wp__sheet` shell from the web-preview viewer so the header and close controls match). The prompt sheet is a **compact, content-sized card** — `flex-grow: 0`, `height: auto`, and `margin: auto 0` keep it centered and prevent it from stretching to the overlay height, so the hint text always sits directly under the Preview button with no dead void at any width.
- `frontend/src/components/chat/FileToolbar.jsx` gains an `onOpenPreview` prop plus `customActions` / `onRunCustomAction` / `onRefreshCustomActions` props; when `customActions` is non-empty it renders an **Actions** section (separator + title + one row per action) between the Cli item and the modals. Opening the menu calls `onRefreshCustomActions()` so the list stays fresh. `/api` items use the `M‣` glyph, `cli` items `›_`.
- `frontend/src/components/chat/Chat.jsx` wires `onOpenPreview`, renders the prompt, and `runPreviewFromPrompt()` captures the URL through `requestWebpreview()` (no model round-trip). It also passes the chat's `customActions`, `runCustomAction`, and `refreshCustomActions` into the toolbar. The former `Actions` section of the Tools popup is removed — `ActionSheet.jsx` is deleted.
- `frontend/src/components/chat/CliModal.jsx` owns a `CliScreen` instance (one per session lifespan) and feeds every `cli_output` frame through it; it renders `screenRef.current.render()` after each write and re-pins to the bottom only while `pinnedRef` is true. The decoder is covered by `scripts/test-cli-strip-ansi.js` (split escapes, redraw-in-place, scrollback) alongside the existing `stripAnsi` assertions.
