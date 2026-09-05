# File toolbar — implementation notes

> Agent-facing reference for [`docs/features/file-toolbar.md`](../../features/file-toolbar.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Backend API

`GET /api/git/info?projectDir=<abs>` returns `branch`, `branches` (local + remote), `ahead`/`behind` (counts against upstream), `stashes` (each `{ index, subject, date }`), `staged`, `unstaged`, and the first 20 `commits` — commit metadata only, no per-commit file lists (see [src/server-handlers-git.js](../../src/server-handlers-git.js)).

`GET /api/git/commits?projectDir=<abs>&offset=0&count=20` returns paginated commits with `{ ok, commits, total, offset, count }`. Commits carry only metadata — their changed-file lists are fetched lazily per commit.

`GET /api/git/commit-files?projectDir=<abs>&hash=<full-or-short>` returns the full changed-file list for one commit: `{ ok, files }` where each file is `{ path, status, statusText, diff }` (each per-file diff preview is capped at 120 lines; the file list itself has no cap). This is called by the modal the first time a commit row is expanded, so file lists are fetched on demand instead of for every commit in the list.

`POST /api/git` accepts `{ projectDir, action, args?, files?, message? }`. Actions: `status`, `diff`, `log`, `add`, `unstage`, `commit`, `branch`, `checkout`, `stash`, `stash-apply`, `stash-pop`, `stash-drop`, `push`, `pull`. `add` and `unstage` accept either a space-split string `args` or an array `files`; the array form passes each path to git as its own argv element, so file names containing spaces are safe. `unstage` maps to `git reset -q HEAD -- <path>` (compatible with repos that have no commits yet). `commit` requires `message`.

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
- File: `src/server-handlers-git.js` (backend — `handleGitInfo` / `handleGitLog` / `handleGitCommitFiles`)
- File: `src/server-shared.js` (backend — `broadcast` reused for `cli_output` frames)

The toolbar is a stateless Preact component that receives `projectDir` and `onOpenFileEditor` as props. The git and CLI modals each own their fetch/SSE state (loading / error / retry) and collapse/expand independently. Both modals are **lazy-loaded**: `FileToolbar.jsx` holds a `useEffect` per modal that calls `import('./GitModal.jsx')` / `import('./CliModal.jsx')` only when that modal is first opened (mirroring how `Chat.jsx` lazy-loads the file editor). Vite emits them as separate chunks (`GitModal-*.js`, `CliModal-*.js`) with no `modulepreload` hint in `index.html`, so the browser fetches them only when the user opens the modal, not at page load. On mobile, all three full-screen overlays apply `--safe-top` and `--safe-bottom` padding because fixed overlays sit outside the app shell's safe-area padding; this keeps their headers below the device status bar and their content above the home indicator. The file editor's path field is the only flexible header item and is allowed to shrink to zero, ensuring the back, go, refresh, and close controls remain visible even for long paths on narrow screens.

The CLI session is a single persistent child process per project (`windowsHide` on Windows, no window shown), keyed by the resolved project directory. Child processes are reaped on server exit via an exit hook, mirroring the native `shell` tool. The trigger icon is a stack of three inline SVGs: an up-chevron, the folder in the middle, and a down-chevron, all rendered with `fill: currentColor` like every other icon in the app. Each element is a separate SVG (folder 18×14, chevrons 12×6) with 2px gaps, so all three are clearly visible. Earlier attempts used `▲`/`▼` text glyphs (U+25B2/U+25BC), which render as color emoji on some mobile fonts and collapse into a single visible icon, and a single 14px two-triangle SVG, which was too small to read as two icons.
