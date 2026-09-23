# File toolbar — implementation notes

> Agent-facing reference for [`docs/features/file-toolbar.md`](../../features/file-toolbar.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Backend API

`GET /api/git/info?projectDir=<abs>` returns `branch`, `branches` (local + remote), `ahead`/`behind` (counts against upstream), `stashes` (each `{ index, subject, date }`), `staged`, `unstaged`, and the first 20 `commits` — commit metadata only, no per-commit file lists (see [src/server-handlers-git.js](../../../src/server-handlers-git.js)).

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

- The `+N` / `−N` counts are styled in `frontend/src/chat-composer.css`. `.file-toolbar__folder > svg path { fill: var(--fg) }` **pins** the folder glyph — it deliberately does not follow the chevrons' `currentColor`, so the backing stays light even when the trigger switches to `--accent` on open. `.file-toolbar__git-stats` positions the counts inside it (`inset: 4px 3px 3px`, `0.46rem`, weight 800, `letter-spacing: 0.01em`, tabular numerals) and `.file-toolbar__git-additions` / `.file-toolbar__git-deletions` color them `#006600` / `#b30000`. The pin is what allows a single color per count with **no per-state override**, replacing an earlier four-color arrangement (`#0b4a1e` / `#7d1717` plus deeper `#052e12` / `#5c1010` under `[aria-expanded="true"]`).
- **Size.** The folder box is 28×22 and the chevrons 14×7, giving a 38px stack inside the 40px painted circle — 8px of headroom existed at the old 24×18 / `0.38rem`, and this uses all but 2px of it. The counts measure ~7.4px instead of 6.08px. Growing further (a 32×26 folder) exactly fills the 40px circle and is the hard ceiling.
- **Width budget.** `.file-toolbar__git-additions` / `.file-toolbar__git-deletions` use `max-width: 100%` of the 22px stats container rather than a fixed cap. The two counts occupy separate rows (top-left, bottom-right), so they cannot collide horizontally and each may span the container. A narrower cap is what used to truncate long counts: `+1234` needed 17.6px against a 16px cap, and `+9.9k` needed 18.4px against 18px. The widest string `frontend/src/components/chat/gitCount.js` emits is 5 characters (`+` plus four, e.g. `+995k`) at ≈21px, which fits.
- **Abbreviation** lives in `frontend/src/components/chat/gitCount.js` (`formatCount`), a plain ESM helper so node can test it. It steps the unit whenever the mantissa would round to 1000, so 999 500 becomes `1M` rather than `1000k`; the longest possible result is 4 characters. `off-by-one` boundaries and that invariant are covered by `scripts/test-git-count-format.mjs`, which is wired into the `lint` and `test` scripts. Abbreviation is display-only: `FileToolbar.jsx` builds the `aria-label` from the raw counts.
- **Zero handling** is in `FileToolbar.jsx`: a zero count is hidden only when its sibling is non-zero (the `+0` beside a `−25` is the noise worth removing). When both are zero the pair is drawn as `+0` / `−0`, so a clean tree still reports state instead of looking like the counts failed to load. The `aria-label` always carries both exact figures whenever stats exist, including zero sides.
- **Contrast budget, and why the pin matters.** Both counts measure 6.1:1 / 6.0:1 against the pinned `--fg` fill. The pinned fill itself is 13.2:1 against the default button circle and 11.0:1 against the hover/open one, while sitting 1.6:1 off the chevrons — a deliberate trade, since they are separate shapes. Pinning also raises the achievable colorfulness: at the lightest backing the count hues reach OKLCH chroma 0.150 / 0.198, against 0.095 / 0.137 when the fill followed `currentColor` and had to clear the mid-tone accent state too. If the folder fill is ever darkened, both count colors must be re-validated — they are checked against `#eceaf1` only.
- **Do not try to make these counts bright.** Against a light backing the best any bright hue manages is ~1.7:1 (lime `#d6ff3a` is 1.68:1 and 1.04:1 on the lighter hover fill — invisible), so the counts are necessarily at the dark end. Darkening the folder to `--bg` instead (to back bright digits) drops the folder's own contrast against the button circle to 1.24:1, at which point the icon stops reading as a folder. Both were tried and reverted. Also avoid `--surface-2` / `--surface-3` as a folder fill: those are the button circle's default and hover/open fills, so the folder would vanish in one state. These ratios are computed by hand — no automated test asserts them.
- The commit options menu lives in `CommitMenu` inside `frontend/src/components/chat/GitModal.jsx`. Copy actions run client-side (`navigator.clipboard` with an `execCommand` fallback); the git actions **checkout / cherry-pick / revert** set a pending action and are confirmed through an in-app `GitConfirm` sheet (own `.gm__confirm-*` classes rather than the Inspector's `ConfirmSheet`, because `inspector.css` is lazy-loaded and not guaranteed in the chat view). Only **logger/read** actions and the explicit-save actions are exposed — `cherry-pick` and `revert` create new commits, and `checkout` moves to a detached HEAD, so each is explicit. These map to new `SAFE_ACTIONS` entries in `POST /api/git` (`cherry-pick`, `revert`; `checkout` already existed). `revert` passes `--no-edit` so it never blocks on the commit-message editor in the non-TTY child. Backed by `scripts/test-git-commit-actions.js`.
- Stage / unstage operate on the **source path** of a rename (`old -> new` splits on `->` and uses the first part), because `git add -- old` records the rename while adding the new name too would stage its content as a separate file. The array `files` body form (`{ projectDir, action, files: [...] }`) passes each path to git as its own argv element, so file names with spaces survive intact. `unstage` runs `git reset -q HEAD -- <path>`, which is compatible across git versions (git ≥2.23's `git restore --staged` would work too, but `reset` also handles the case where the index has no HEAD yet).
- `frontend/src/components/chat/PreviewUrlPrompt.jsx` renders the URL-entry overlay (`wp__prompt-sheet`, reusing the `.wp__overlay` / `.wp__sheet` shell from the web-preview viewer so the header and close controls match). The prompt sheet is a **compact, content-sized card** — `flex-grow: 0`, `height: auto`, and `margin: auto 0` keep it centered and prevent it from stretching to the overlay height, so the hint text always sits directly under the Preview button with no dead void at any width.
- `frontend/src/components/chat/FileToolbar.jsx` gains an `onOpenPreview` prop plus `customActions` / `onRunCustomAction` / `onRefreshCustomActions` props; when `customActions` is non-empty it renders an **Actions** section (separator + title + one row per action) between the Cli item and the modals. Opening the menu calls `onRefreshCustomActions()` so the list stays fresh. `/api` items use the `M‣` glyph, `cli` items `›_`.
- `frontend/src/components/chat/Chat.jsx` wires `onOpenPreview`, renders the prompt, and `runPreviewFromPrompt()` captures the URL through `requestWebpreview()` (no model round-trip). It also passes the chat's `customActions`, `runCustomAction`, and `refreshCustomActions` into the toolbar. The former `Actions` section of the Tools popup is removed — `ActionSheet.jsx` is deleted.
- `frontend/src/components/chat/CliModal.jsx` owns a `CliScreen` instance (one per session lifespan) and feeds every `cli_output` frame through it; it renders `screenRef.current.render()` after each write and re-pins to the bottom only while `pinnedRef` is true. The decoder is covered by `scripts/test-cli-strip-ansi.js` (split escapes, redraw-in-place, scrollback) alongside the existing `stripAnsi` assertions.
