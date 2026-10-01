# Changelog

All notable changes to `mouaif` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut from `package.json` with `npm version <patch|minor|major>`,
which is the version shown by `mouaif info` and printed by `mouaif --help`.

## [Unreleased]

## [0.8.5] — 2026-10-01

### Added

- **Reviewed chat screen capture** — capture the full screen or changed areas,
  ignore or mask zones, import video frames, and attach only selected PNGs from
  the always-enabled Screen capture item in the chat File tools menu.
- **Grouped file tools** — read or edit up to 50 files in one call, with an
  individual result for each entry.

### Changed

- **Ordinary native app tools** — chat and app actions are separate functions
  with individual selection and Off / Ask / Allow permissions. Legacy `mouaif`
  selections and permissions migrate automatically.
- **Rewritten built-in prompts** — the `very-small`, `average`, and `extensive`
  system prompts now lead with a short role statement and group their rules
  under four headings (`Answering`, `Acting`, `Editing`, `Reporting`). Every
  rule is affirmative, states the condition that triggers it, and names the
  tool argument or command form it depends on, so the model can act without
  guessing. The three profiles still compose by appending, so the shared core
  stays byte-identical and the profiles cannot drift into contradicting each
  other. Prompt ids, the `average` default, the resolution order, and tool
  reduction are unchanged.

### Fixed

- **Subagent transcript parity** — nested runs retain their prompt, chat
  details, progress, and cost, with mobile-friendly expanded cards.
- **Project tool settings** — permission changes confirm only successful saves,
  report MCP save failures, preserve timeout bounds, and restore the tool output
  size control. Removing keys in the raw project editor persists correctly.
- **Authorization notifications** — permission requests remain visible and
  direct tool calls send authorization pushes.
- **Test-store isolation** — test children and symlink aliases cannot
  accidentally open the real app store; dictation HTTP coverage now separates
  project-only catalogs from live model discovery. Composer browser coverage
  launches its own isolated Chrome, and CLI key guards match the shared hardware
  and on-screen key handler.
- **Release assets** — package and lockfile versions agree, and generated
  documentation pages match their Markdown sources.
- **A `mouaif` action row now toggles the tool** — the tool's two categories
  (`Chats`, `mouaif`) list their actions as child rows, but a child row is keyed
  by its action (`mouaif:list`) while the per-chat tool filter stores tool
  **names**. A tap on an action row therefore named a tool that does not exist,
  the unknown name was dropped, and nothing was written: the checkbox snapped
  back on the next rebuild and the chat was never saved — only the category
  checkbox worked. Every row now resolves to the tool it belongs to, so checking
  or unchecking any action writes `mouaif`. The resolution lives in one shared
  pair (`groupToolNames` / `childToolName` in `ToolTree.jsx`) that the chat Tools
  card and the composer tools popup both call; they previously each carried their
  own copy, and only the popup got it.
- **Tab walks the matches in the prompt, not the terminal** — a Tab puts its
  result where you are typing: the first tap completes, each further tap on the
  same line swaps in the next match and wraps (`frontend/` → `frontend/build/` →
  `frontend/dist/` → …). The candidate list is frozen for the run, so it can
  never append to itself, and typing, a chip or ↑/↓ ends the run.
- **A named folder now shows what is inside it** — at `frontend/` (or with a
  partial segment inside it, `frontend/s`) Tab had nothing left to append, so
  the sheet could only report "no further completion": true, and useless on a
  phone with no way to run `ls`. The suggestion row now lists the folder's
  contents, and a chip rewrites the whole line so the command survives the tap
  (`ls frontend/` → `ls frontend/index.html`). The notice points at the row
  instead of reading like a dead end.
- **CLI Tab completes a folder you name** — typing `frontend/` (or `frontend`)
  and pressing Tab was a dead end: a directory was only ever listed when a
  completion *landed* on it, and a word already ending in `/` was refused
  outright. Tab now lists the folder the line names on every tap (`frontend` →
  `frontend/`, then `frontend/vite.c` → `frontend/vite.config.js`), from a
  per-sheet cache of listings so returning to a folder is instant. Two related
  fixes came out of the same change: a name-phase completion no longer drops the
  command (`ls src/` used to become `src/`), and a directory fetched earlier can
  be the source again instead of being skipped by a dedupe set.
- **CLI Tab explains itself instead of doing nothing** — a Tab that cannot
  advance the line now says why for a moment under the key rows (`No match here
  — only this folder and the ones already opened are searched.`, `No further
  completion — 3 matches.`, `Nothing to complete — type part of a command or a
  path.`). Typing clears it. A silent no-op is indistinguishable from a broken
  key on a phone, which is exactly why the symptom was so hard to pin down.
- **CLI Tab completes inside a folder** — Tab's only name source was a one-shot
  listing of the project's top level, so a path into a folder (`ls src/comp`,
  `git add src/…`) had no candidates at all and Tab changed nothing. The tap
  that lands on a directory now lists it, so the next Tab completes its
  children (`src/comp` → `src/components/`, then
  `src/components/Ch` → `src/components/Chat.jsx`), one level per tap, each
  directory listed at most once per sheet.
- **CLI key row works inside programs** — Tab and the arrows used to do
  nothing while `less`, `top`, `vim` or an interactive picker ran; every key
  now sends its sequence to a running program (application-mode arrows
  included) and edits the prompt only at the shell. Esc at the prompt clears
  the line instead of swallowing the next letter. A second row adds ←, →,
  PgUp, PgDn, and ^Z / ^L join the first; the close button is 44 px.
- **CLI Tab completes again after a killed full-screen program** — `less`,
  `top` or `htop` killed with `^C` never writes the sequence that leaves the
  alternate screen, so the modal stayed in program mode for the rest of the
  session and every key kept writing raw bytes at a shell that was back at its
  prompt: Tab stopped completing anything. The shell's own prompt marker now
  leaves the alternate screen, so Tab, ↑/↓ and the prompt keys work again
  without reopening the sheet.
- **Denied-operation prompt guidance** — all three non-empty built-in profiles
  now instruct the assistant to stop a denied operation, including attempts
  through another tool, and ask for clarification or continue only with
  permitted work.

## [0.8.0] — 2026-09-27

### Added

- **Built-in prompts in the prompt editor** — Very small, Average, Extensive,
  and Chat open in the same editor as a custom prompt; the title and text are
  read-only, while each profile can be given an icon and pinned to a project
  card to start a chat with that prompt size.
- **Project card search** — a magnifier on a project card searches that
  project's chats, drafts, and messages.

### Fixed

- **Settings Back arrow** — the app-scoped sub-pages (MCP servers, custom
  prompts, custom actions) and the chat-scoped project settings now build their
  Back links through one URL-safe helper, so Back returns where you came from
  instead of falling back to the Chats tab.
- **@-mention category filter** — tapping a category chip and then typing keeps
  the filter applied instead of expanding back to every category.
- **Subagent progress** — a `report_progress` / `task` call made by a subagent
  shows its title and percentage inside the nested row, tagged with its parent
  call, instead of drawing a separate card at the bottom of the transcript.
- **Status notification usage** — each round is counted once in the token and
  cost row, so a 262-token turn no longer reports 671 tok.
- **Custom-prompt editor on mobile** — no empty Chat profile in the picker,
  `<title> (new)` for an unsaved prefilled prompt, Create/Save disabled until
  the prompt has content, a full-width scope segment, and the Save / Create /
  Delete bar pinned to the bottom of the screen.
- **Chat preset tree** — always shown, with the Agent files and Skills rows
  named instead of rendering as a bare `off`.

## [0.5.7] — 2026-09-26

### Added

- **Chat scroll navigation** — 26 px previous / next / bottom arrows anchored to
  the transcript, each with a 44 px tap area.
- **Web preview Live mode** — an unrestricted `Live` iframe the viewer can show,
  and that the agent can open by calling the preview tool with `mode: live`.
- **Per-chat prompt snapshot** — pin a chat's custom prompt so the chat keeps
  using that text even if the prompt is later edited.
- **Attach any text file** — an `@`-mention attaches every text file, not only
  allowlisted code files.

### Changed

- **Prompt profiles** — `chat` is a plain prompt-style value that no longer
  unchecks every tool, and a chat preset starts from the all-on tool baseline.
- **Tools popup** — the auto-retry switch and its label sit side by side, and
  the redundant auto-retry row is gone from the footer.
- **Chat UI** — the `ask_user` question card is compacted for phones, the file
  orb is a clear glass bubble with translucent, textured counts, and the
  transcript fills the screen above 600 px so the composer stays at the bottom.
- **Inspector** — the Styles panel's element identity chip is smaller.

### Fixed

- **MCP robustness** — tool calls are cancelled on Stop and honour server
  timeouts, in-flight calls fail fast when a server crashes, and composed tool
  names are sanitized to provider limits.
- **Chat ordering** — message rows keep their `seq` order around client-only
  rows and tool turns.
- **Retired prompt** — the auto-seeded Chat prompt is dropped from app settings.
- **Tool list** — `/api/tools/list` answers without a `projectDir`.

## [0.5.0] — 2026-09-26

### Added

- **MCP OAuth** — the client-credentials grant, confidential clients with a
  keychain-stored secret, RFC 7009 revocation, and the legacy SSE transport.
- **GitHub Copilot provider** — GitHub device-code sign-in, a per-chat Copilot
  token exchange, and a live model list.
- **Background terminal** — a CLI shell session that survives closing the sheet.
- **MCP store** — the registry browser is a user-friendly store.
- **`chat` prompt profile** — an empty system prompt with no tools checked.
- **Hide the status line** — an option to drop the status line under the chat
  composer.
- **Web preview flexibility** — any URL scheme and any viewport size.

### Changed

- **Performance** — the web-preview viewer and image annotator load lazily,
  static assets are served brotli/gzip-compressed, and the server lazily loads
  `ws`, `web-push`, and `keyring` with bounded in-memory tables.
- **Chat** — tok/s is measured per round and stored on each assistant row,
  in-flight subagent cost stays in the live total, the transcript stays pinned
  while a reply streams, and every message has a Copy action.
- **CLI modal** — runs on a pseudo-terminal (ConPTY on Windows), with Tab
  completion, suggestion rows, and key rows.
- **Git modal** — one reducer, 44 px controls, real stash refs, and a guard
  against option injection in `/api/git`.
- **Settings** — the hide-file-content editor is redesigned for touch, and the
  Settings sub-pages scroll to the bottom on flush routes.

### Fixed

- Streaming replies and early shell output reach chat followers, the persisted
  segment's real `seq` is broadcast, and the tail append no longer draws a live
  reply twice.
- MCP start failures explain themselves and the start control is recognizable.
- The Inspector opens a new window when Chrome has no browser window left, and
  the Styles tab is easier to read.
- Several chat card fixes: tool rows folded inside a subagent card, one scroller
  per tool card, the Thinking block stays open when the reply finalizes, and
  the expanded system prompt wraps inside its card.

## [0.3.5] — 2026-09-24

### Added

- **Local OpenAI-compatible servers** — connect llama.cpp's `llama-server` or
  LM Studio with no API key.
- **`@`-mention ranking** — suggestions are ranked, highlighted, and
  fuzzy-matched.
- **CLI terminal modal** — suggestion rows, key rows, and Tab behavior on
  phones and with a hardware keyboard.
- **Chat streaming performance** — incremental live previews, coalesced progress
  updates, and no layout or paint for off-screen transcript rows.

### Fixed

- Refreshed OAuth tokens are persisted under the resolved account.
- The `url.parse` deprecation warning no longer fires on every request.
- CLI sessions hold escape sequences and UTF-8 characters split across output
  chunks, resolve symlinked project paths, stop backgrounded jobs on close, and
  always run on a pty.
- The tail append no longer draws a live reply twice.

## [0.3.2] — 2026-09-22

### Added

- **`search_files` on ripgrep** — with a bounded JavaScript walk as fallback.

### Changed

- npm publishing metadata: license, author, and the public registry.
- `better-sqlite3` upgraded to `^12.11.1` for Windows prebuilts.
- The Inspector panel switcher scrolls with the inspect view.

### Fixed

- Both search backends agree, and a redaction leak in search results is closed.
- The Inspector preview and Styles strip no longer blink.
- No light flash before the bundle stylesheet loads.
- A stale PWA update intent no longer reloads the page later, and an
  unrequested controller change no longer reloads open tabs.
- The Docker image builds (`prepare-web.js` is copied before `npm ci`).
- The status percentage stays on the push bar's line.
- Composer send is guarded during live follow and syncs immediately at run end.

## [0.3.0] — 2026-09-16

### Added

- **Initial public release on npm** — `mouaif` published with a pre-built web UI,
  so `npx mouaif serve --auth` needs no build step.
- Mobile-first tabbed UI (Chats, Dictate, Inspector, Settings) served by
  `mouaif serve` on port `5732`.
- Projects, chats, providers, MCP servers, and the coding tools (shell, files,
  subagents) with per-project **Off / Ask / Allow** gating.
- Access authentication with a setup link and QR code.

[0.8.5]: https://www.npmjs.com/package/mouaif/v/0.8.5
[0.8.0]: https://www.npmjs.com/package/mouaif
[0.5.7]: https://www.npmjs.com/package/mouaif/v/0.5.7
[0.5.0]: https://www.npmjs.com/package/mouaif/v/0.5.0
[0.3.5]: https://www.npmjs.com/package/mouaif/v/0.3.5
[0.3.2]: https://www.npmjs.com/package/mouaif/v/0.3.2
[0.3.0]: https://www.npmjs.com/package/mouaif/v/0.3.0
