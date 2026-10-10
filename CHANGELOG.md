# Changelog

All notable changes to `mouaif` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut from `package.json` with `npm version <patch|minor|major>`,
which is the version shown by `mouaif info` and printed by `mouaif --help`.

## [Unreleased]

### Added

- **Cooperative subagent groups** — parent-created member DAGs with shared objectives, ownership/workspace provenance, discoverable artifacts, proposed versus approved contracts and explicit conflict arbitration. Status is immediate, messages are read-only, explicit sends have delivery receipts, observations and shutdown are bounded. See [the feature page](docs/features/cooperative-subagent-groups.md).

- **Subagent orchestration** — opt-in background handles let the parent observe, steer and cancel isolated nested work while it runs. Parent-only controls and bounded sibling publish/read handoffs share the existing Subagent gate; handles and handoffs expire with the parent turn. Pending approvals cancel per child, final transcripts/costs settle once, and synchronous calls remain the default. See [the feature page](docs/features/subagent-tools.md).

- **Local preview proxy** — the web preview's Live mode framed a page in *your* browser, so `http://localhost:5173/` meant the phone you were holding, where no dev server runs. A local URL is now loaded through mouaif's own `/api/preview/<scheme>/<host>[:port]/<path>` proxy, which fetches the page on the machine running mouaif and re-serves it from the app origin — so a Vite / Next / SvelteKit / static dev server is reachable from any device on your network. The target is a **path prefix**, not a query string, so relative imports and redirects resolve on their own; root-absolute URLs (`/@vite/client`, `/src/main.jsx`, `/style.css`, a root-absolute `Location`) are pointed back at the proxy in the text bodies it serves — HTML, CSS and JavaScript only, never JSON — so a whole module graph loads and a Vite page boots inside the frame. The viewer's footer reads `via proxy`. Loopback and the container-to-host aliases (`host.docker.internal`, …) only — every other host is `403`; `GET`/`HEAD` only; cookies cross in neither direction; the frame is never cached and no upstream `X-Frame-Options` / CSP is forwarded. See [docs/features/local-preview-proxy.md](docs/features/local-preview-proxy.md).

- **Grouped CLI tool** — a new native `group_cli` tool runs an ordered list of shell commands in one call and reports every entry's own stdout, stderr, exit code and duration, instead of stopping at the first failure. An entry marked `"async": true` (or a whole call marked `async`) is **started in the background**: the call returns immediately with a pid and a log path under the project's `.mouaif/logs/`, the command keeps running, and later entries can run while it is up. Each entry reuses the single shell runner, so the working folder, interpreter resolution, environment denylist and output cap cannot drift from a `shell` call, and the live preview streams per entry. It is a leaf of the `mouaif` tool family and ships with [its own doc](docs/features/grouped-cli-tool.md).

- **Built-in `mouaif-config` skill** — the app now ships one skill of its own, so a project with no `.agents/skills` still has something to activate. It teaches the assistant to read and change a project's configuration through `get_settings` / `update_settings`: which settings key lives at app or project scope, the provider ids a project model may reference and which of them are key-based versus plan sign-ins, agents, the tool-authorization gates with their `off` / `ask` / `allow` modes, and that MCP servers are configured in the app. It appears, toggles and can be disabled like any other skill, and a project's own `.agents/skills/mouaif-config/SKILL.md` replaces it.

### Changed

- **Working-folder changes no longer manage Git** — the tool only ever selected directories; Git isolation is coding-prompt guidance carried out through separately authorized shell calls. Existing folders and externally prepared worktrees are reused unchanged; the legacy `branch` result stays `null`.
- **Explicit directory approvals** — **Change working folder** cards explain where files read or edited and commands run for the named chat will work, including recovered pending approvals. Implementation details stay out of the approval.
- **`change_working_folder` selects folders, it never creates them** — the tool is now `directory` (required: an existing folder, or `""` to return to the project folder) plus an optional `chatId` defaulting to the calling chat. The default `.mouaif/workspaces/<chatId>` folder, the **Allow automatic workspaces** opt-in and its two settings switches, the `EOFF` result and the boolean/null `directory` values are gone: preparing a workspace — including a Git worktree — is an authorized shell command the user can see and approve. A one-time migration removes the retired `autoWorkspace` key from the app store and from every project, so a store that ran the old switch does not keep a value nothing reads.
- **`change_working_folder` option surface** — previously the `directory` argument advertised `string | boolean | null` while the description named only `false`, and the three destination paths each rejected a bad value with their own wording. It is now a plain required string with one shared refusal message.
- **Working-folder tool takes a `chatId`** — the chat still defaults to server context, so the common call is unchanged; naming another chat is now allowed the same way `get_chat` does, and the approval card names the target.
- **Subagents get their own working-folder state** — a delegated run starts in the parent chat's folder and can switch it without affecting the parent conversation or its same-turn siblings. Siblings still share a checkout until they explicitly select different directories. `directory` resolves against the folder the run started in, so the same argument always names the same folder, and a run never creates one (`created` stays `false`). Run folders are live process state for that run, never chat metadata, and are dropped when the run settles.
- **Subagents get their own working-folder state** — a delegated run starts in the parent chat's folder and can switch it without affecting the parent conversation or its same-turn siblings. Siblings still share a checkout until they explicitly select different directories. `directory` resolves against the folder the run started in, so the same argument always names the same folder, and a run never creates one (`created` stays `false`). Run folders are live process state for that run, never chat metadata, and are dropped when the run settles.

### Fixed

- **Codex models are listed again** — the chat model picker was empty for a
  signed-in ChatGPT plan because the Codex catalog request advertised a pinned
  `client_version` of `0.99.0`, and that endpoint answers with the model set of
  the named CLI release: anything below roughly `0.150` comes back as the
  hidden `codex-auto-review` row alone, which the adapter then filtered out.
  Chatting with a model id already in the project kept working, because chat
  never reads that catalog — which is what made it look like an account or
  sign-in problem. The request now advertises the newer of mouaif's own version
  and a floor it keeps current, and a catalog that is empty after filtering is
  reported as an upstream failure (`Codex returned no available models for
  client_version …`) instead of a silently empty list. The floor matters on its
  own: a merely old-enough version still hides models the account can use. See
  [docs/features/codex.md](docs/features/codex.md).

- **A failed MCP server start now shows the child's own error** — a stdio
  server that died before the MCP handshake reported only
  `EMCP_START: MCP error -32000: Connection closed`, which names no cause. A
  `docker run` against a missing or private image — the documented Docker
  install path in the [MCP store](docs/features/mcp-registry-browser.md) —
  prints `pull access denied` to **stderr** and exits, and that output was
  captured into a buffer nothing ever read: `startServer` untracked the session
  before throwing, so the text was discarded with the process. The stderr tail
  now rides the error response, the Settings row appends its first line to the
  typed error, and the error modal shows the full output under a **Server
  output** heading. Servers that wrote nothing get no such section. The buffer
  is also capped in characters rather than chunks — the old check compared an
  array length against a byte cap — and a clipped capture says
  `truncated: true`. See [docs/features/mcp.md](docs/features/mcp.md).
- **The subagent card is bounded again** — a delegated run's conversation
  panel had no height cap, so a run with many tool rounds drew a card taller
  than the screen: the rest of the chat — and the card's own head — was pushed
  out of reach behind one message. The panel is capped at `60dvh` and is now
  the card's single scroller; the nested prompt's own `50dvh` cap is removed
  inside it, because a second scroll box nested in the first swallowed the
  swipe. The cap had been attempted before and appeared to do nothing: the
  panel's rules sit on the `.tool-card`-qualified selector (0,3,0) while the
  obvious place to write a cap — `.tool-card--subagent .tool-card__body`
  (0,2,0) — loses the cascade to the generic expanded-body rule. A regression
  test now pins the cap to the selector that wins. See
  [docs/features/subagent-transcript.md](docs/features/subagent-transcript.md).
- **Provider model catalogs follow the connection** — Azure, Ollama, Mistral,
  and Gemini read their live model list from the URL you configured. Azure's
  adapter joined Azure's *empty* default base URL, producing the relative
  `/openai/models?api-version=…`, which `fetch()` rejects outright: the live
  catalog could never answer, and no test noticed because the tests stubbed
  `fetch` and never passed a base URL. It now derives the resource origin from
  the deployment URL and fails early with a typed `EBADINPUT` naming the URL to
  fill in when none is set. Ollama hard-coded the loopback default while
  `buildOllamaRequest` honored `model.baseUrl`, so a remote Ollama connection
  was offered localhost's models. Mistral's catalog hard-coded
  `api.mistral.ai`, so a connection pointed at a gateway, proxy, or regional
  host listed the public vendor catalog while chat went elsewhere. Gemini's
  chat and image builders, and both of its catalogue slices, now read the
  connection's base URL — the builder had hard-coded the public API root even
  though the Anthropic, Ollama, and dictation paths honored `model.baseUrl`,
  so a configured Gemini proxy listed one host's models and chatted against
  another's. See
  [docs/features/providers.md](docs/features/providers.md).
- **OAuth namespaces the keyring cannot see** — `AI_TO_AUTH_PROVIDER` mapped
  `ollama`, `azure`, `mistral`, `groq`, and `deepseek` to keyring namespaces
  that `SUPPORTED_PROVIDERS` did not list. `serviceName()` rejected them with
  `EPROVIDER` and `readIndex()` dropped them from the account index, so an
  `oauth`-flagged connection on one of the API-key-only providers failed with
  "unknown provider" instead of a clean `ENOAUTH`, and `indexAdd()` could not
  write. The namespaces are now listed. The web bundle's `authNsForProvider()`
  also mapped `openai-compatible` but not `gemini`, so the provider form read
  `accounts.gemini` while the server indexed that account under `google` and a
  signed-in Gemini account stayed invisible. Both relationships are pinned by
  a new parity test,
  [scripts/test-provider-namespaces.js](scripts/test-provider-namespaces.js).
- **The Context pill lost its window on OpenRouter and Mistral** — the model
  parser read only `context_window`, but OpenRouter reports `context_length`
  (on all 465 of its chat models, with `context_window` on none) and Mistral
  reports `max_context_length`. Those connections therefore showed a bare
  `context 14.8K` with no `/200K (7%)` fraction, in both the per-turn line and
  the chat header. The window is now read under any of the names providers use,
  and a provider that reports none still yields no window rather than a guess.
  See [docs/features/usage-metrics.md](docs/features/usage-metrics.md).
- **The Balance pill could never appear for Mistral or Groq** — balance was
  looked up through the OpenAI *dashboard* routes
  (`/dashboard/billing/credit_grants`, `/subscription`, `/usage`), which live on
  api.openai.com. Mistral and Groq answer 404 for those paths — and for a bogus
  path too, i.e. a catch-all, so the route does not exist — which meant every
  chat-open fired requests that could only fail, and the docs described a chip
  that never rendered. Groq now reports "unsupported" without a request;
  DeepSeek reads its own documented `GET /user/balance`; and Mistral reads the
  Admin API's `GET /v1/admin/spend-limit` (monthly limit minus usage).
  Mistral's own docs disagree on that route's auth — the prose guide specifies
  `x-api-key`, the OpenAPI scheme declares a bearer token — so the key is sent
  under both names rather than betting on one. It needs an Admin-scoped key, so
  a standard workspace key still shows no chip — correctly, since the figure is
  not readable with it.
- **Canonical folder approvals and run validation** — working-folder cards and allowlists use the real destination behind symbolic links. A destination changed during approval fails with `ESTALE_PATH` instead of switching elsewhere. Selected subagent folders and resets enforce the chat's home guard while inherited temporary projects keep their existing local sandbox.
- **Delegated folder identity** — subagents retain the real parent chat for permissions, approval decisions, pending recovery, cancellation, tasks and chat tools. Only local folder operations use the separate run id; attachment reads follow the run's folder. Missing selected folders fail instead of silently launching a delegate in the original project.
- **Native tools now work on Azure, Mistral, Groq, and DeepSeek** — the
  streaming loop's advertisement gate named only `openai-compatible`,
  `openrouter`, and `github-copilot`, so a chat on any of the four cloud
  providers attached no `tools` field at all: the model never saw `shell`,
  `read_file`, `ask_user`, the chat/app tools, or an MCP tool, and nothing in
  the UI said why. The four are OpenAI's `/chat/completions` verbatim and
  always shared its builder and parser. The membership now lives in one place,
  `src/providerShapes.js` → `supportsOpenAIToolLoop()`, read by both the gate
  and the history-reconstruction mirror so the two cannot drift again. Ollama
  stays deliberately excluded: its native `/api/chat` returns function results
  as `{ role: 'tool', tool_name, content }`, not the loop's
  `tool_call_id` shape. See
  [docs/features/cloud-providers.md](docs/features/cloud-providers.md).

### Performance

- **Chat search answers instantly on large projects** — the search query was
  folding every matching message before ranking, so a common term read a
  project's whole transcript: on a project with 286 000 stored messages and
  about 850 MB of text, `the` took about three seconds. The recency index now
  drives the query and the page limit stops the walk, and a chat whose title or
  draft matched is no longer scanned at all: the same search answers in 4–15 ms.
  A term that is genuinely rare still reads the transcript, which is the price
  of substring matching without an index. See
  [docs/features/project-card-search.md](docs/features/project-card-search.md).

## [0.8.7] — 2026-10-04

### Added

- **Per-chat working folders** — `change_working_folder` switches a chat's
  shell and file directory, or creates `.mouaif/workspaces/<chatId>` as a Git
  worktree on a new branch. Automatic workspace creation is opt-in: it is a
  switch in Settings → Project → General with an app-level default in Settings
  → App defaults, both off by default, and the folder is created lazily so a
  failed change leaves nothing behind.
- **OpenAI Codex provider** — ChatGPT-plan device sign-in, keychain-backed
  refresh, live Codex models, and Responses streaming with native tool calls.
- **Reviewed subagent images** — generated artwork can be edited in a follow-up
  run, its pixels are stored once, and `subagent.images` selects current-chat
  `imageRef` values explicitly; nothing transfers automatically.
- **Chat-navigation tools** — `search_models` and `start_chat` join the Chats
  family, and the `mouaif` family gains a restart and a feature-report tool.

### Changed

- **Per-family tool gates** — `Chats` and `mouaif` each get a single Off / Ask /
  Allow gate with optional per-function overrides, the same shape File tools
  already had. Progress updates, Ask user, Task, app restart, Web preview, and
  the remaining app functions moved under those two families, so the tool tree
  stopped growing one top-level row per function.
- **Landing page** — leads with what the app does that others do not, gives
  every app page its own section, shows the code editor, and no longer repeats
  its own capability sections.

### Fixed

- **Chat scroll navigation is an overlay again, and no longer eats Space** —
  the arrow controls float over the transcript's corner instead of occupying a
  reserved row between the messages and the composer, so the transcript keeps
  the full height above the composer. They are also held out of the tab order:
  a focused arrow button swallowed <kbd>Space</kbd>, so scrolling the
  transcript with the most natural key jumped to the previous message instead.
  Every control keeps a 44 px hit area around its 26 px painted glyph.
- **Subagent image payloads** — nested image data is omitted from tool
  feedback, concurrent chat attachments are preserved, and chat drafts refresh
  after delegated attachment tools.
- **App tools** — `update_settings` and `delete_chat` are hardened against bad
  input, and the `@`-picker restart form runs directly instead of spending a
  model turn.
- **CLI terminal** — the key row is smaller and gains Ctrl / Fn modifier keys.
- **Authorization** — permission changes confirm only successful saves and
  report MCP save failures.

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
