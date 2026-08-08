---
applyTo: "**"
description: "Always-on rules for the mouaif project: autonomous commit-by-commit work, mobile-first UI, and per-feature static-page documentation."
---

# mouaif — Agent Instructions

These rules apply to every change made in this workspace. Follow them without being asked again.

## 1. Coding style — autonomous, one commit per feature

- Work **autonomously**: do not pause to ask for confirmation on small implementation details. Make a reasonable decision and move on. Only stop the user for genuinely ambiguous product questions (e.g. destructive actions, conflicting requirements).
- **One feature = one commit**. Scope each change to a single, well-named feature or fix.
- Use **Conventional Commits** for every commit message:
  - `feat: ...` — new user-facing feature
  - `fix: ...` — bug fix
  - `refactor: ...` — internal change with no behavior change
  - `docs: ...` — documentation only
  - `chore: ...` — tooling, deps, config
  - `perf: ...` — performance improvement
  - `test: ...` — adding or fixing tests
- Keep commits small, focused, and revertible. If a change spans two features, split it.
- Before finishing, run `node -c` (or the project's lint) on touched files and confirm no regressions in the existing `mouaif serve` flow.

## 2. UI — mobile first

- Every UI surface is **designed for mobile first**, then scales up to tablet/desktop.
- Layout assumptions:
  - Primary viewport: 360–430 px wide, single column.
  - Touch targets ≥ 44 × 44 px.
  - Use safe-area insets; do not assume a desktop chrome.
  - Avoid hover-only affordances; everything must work on tap.
- Use system font stacks and responsive units (`rem`, `%`, `dvh`) — no fixed pixel widths for containers.
- Tab bars, bottom sheets, and stacked cards are preferred over multi-pane desktop layouts. Desktop is treated as "the mobile UI with extra room," never the other way around.
- Test at narrow widths before declaring a UI feature done.

## 3. Documentation — per feature, static-page ready

- **Every new feature ships with a doc file** in [docs/features/](docs/features/).
- File naming: `docs/features/<kebab-case-feature-name>.md`.
- Each doc must be self-contained and **deployable as a static page** (GitHub Pages, VitePress, Docusaurus, plain HTML — agnostic to the chosen static site generator). That means:
  - Start with a single H1 title — the page H1.
  - Use H2 sections for major areas, H3 for subsections.
  - Include a short **Overview** (1–3 sentences), then **Usage**, then **Implementation notes** if relevant.
  - All code samples are fenced with a language tag.
  - Images, if any, are referenced by relative path (`./images/...`).
  - No framework-specific shortcodes or templating tags.
- When a feature changes, **update its doc in the same commit** as the code change. Docs and code drift is a bug.
- Add a one-line entry to [docs/README.md](docs/README.md) the first time a feature doc is created.

## 4. Project context — current feature set

These features exist or are planned. Keep this list in sync with the codebase as features land.

- **Virtual list with low memory and low CPU** — windowed rendering, recycled nodes, no forced reflow on scroll.
- **Providers global, models per project** — provider connections and credentials live in the app SQLite store; model IDs are user-defined in project settings and reference a provider. No pre-made model list. See [docs/decisions.md](../docs/decisions.md) §3.
- **AI providers** — six ship today: OpenAI-compatible (any OpenAI-shaped endpoint), Anthropic (key or OAuth), Google Gemini (key), Ollama (no key), **OpenRouter** (key or PKCE sign-in, OpenAI-shaped, OpenRouter model slugs as `id`), and GitHub Copilot (OAuth-only, reserved). Adding a new provider is a localized change: a `buildRequest` + `parseEvent` in [src/ai.js](../src/ai.js), a row in [frontend/src/api.js](../frontend/src/api.js) `SETTINGS_PROVIDERS`, and (if the auth shape differs) an entry in [src/auth.js](../src/auth.js) `AI_TO_AUTH_PROVIDER`. Providers that need their own sign-in flow (PKCE / OAuth / device code) add a `src/oauth-<name>.js` module that exports `register()` and call it from [src/index.js](../src/index.js) at startup. See [docs/features/ai-client.md](../docs/features/ai-client.md) and [docs/features/openrouter.md](../docs/features/openrouter.md).
- **Custom prompts** — user-authored system/role prompts, stored per project. See [docs/features/custom-prompts.md](../docs/features/custom-prompts.md).
- **Three prompt-size profiles**:
  - `very-small`: tool names with short descriptions, no full schemas.
  - `average`: compact prompt + full tool list.
  - `extensive`: full prompt + best-practice guidance and examples.
- **Trace-to-file option** — per-chat toggle (off by default) that writes that chat's events to `<projectDir>/.mouaif/traces/<chatId>.ndjson` in NDJSON, append-only, no rotation, so the user can commit the file with the project. Independent of chat storage; a one-shot "Export trace" action is also available. See [docs/decisions.md](../docs/decisions.md) §5.
- **Agentic coding (shell tool + multi-turn loop)** — the model can call a native `shell` tool that runs commands in the project dir; results are fed back to the model in a real multi-turn loop with no fixed tool-turn limit, so the model can read a file, run a build, read the error, and iterate until completion or user cancellation. Off by default per project; enabled via the **Shell tool** toggle in Settings → Project. Direct `/shell <cmd>` composer command and `POST /api/tools/shell` too. See [docs/features/shell-tool.md](../docs/features/shell-tool.md).
- **Native file tools** — built-in `read_file`, `list_files`, `search_files`, `write_file` tools the model can call to find, read, and edit project files. Same authorization gate and same UI cards as `shell`. Off by default per project, toggled with the **File tools** switch in Settings → Project. See [docs/features/file-tools.md](../docs/features/file-tools.md) and [docs/decisions.md](../docs/decisions.md) §21.
- **App-level vs project-level settings** — settings can live globally (app SQLite store) or in a per-project `.mouaif.json`; project overrides app. See [docs/decisions.md](../docs/decisions.md) §1–§2.
- **Project-grouped chat list** — chats are grouped under a project card; the chat list scrolls inside the card, not the page.
- **Tabbed mobile UI with custom DevTools-style inspector**:
  - Tabs: **Chats**, **Inspector** (rebuilt from scratch on top of Chrome DevTools data — not a thin wrapper), **Settings**.
  - The inspector must be a from-scratch mobile-friendly UI, not the default Chrome panel embedded in an iframe.
  - Data source: Chrome DevTools Protocol (CDP) over WebSocket. See [docs/decisions.md](../docs/decisions.md) §6.
  - Scaffold: **Preact + Vite**, served by `mouaif serve` at `/` (frontend in the `frontend/` dir at the repo root). See [docs/decisions.md](../docs/decisions.md) §7.
- **Project folder picker** — creating a project opens a folder list of existing dirs (anywhere on the filesystem) plus a "create new folder" action. See [docs/decisions.md](../docs/decisions.md) §4.
- **Project card actions** — "New chat" and a per-project options menu on each project card.
- **New-project folder picker** — creating a project opens a folder list (existing dirs) plus a "create new folder" action.

## 5. Stack reminder

- CLI: Node.js, `commander`, HTTP server with REST + SSE ([src/index.js](../src/index.js), [bin/mouaif.js](../bin/mouaif.js)).
- Default port: `5732`. New features must respect this and not change it silently.
- Keep the existing REST + SSE surface stable unless a feature explicitly requires a new endpoint; in that case, document it in the matching `docs/features/*.md` file.
