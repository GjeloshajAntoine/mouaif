# mouaif — Feature documentation

Static-page-ready docs for every feature in mouaif. Each file in `features/` is a self-contained page that can be rendered with any static site generator (GitHub Pages, VitePress, Docusaurus, plain HTML).

The repo ships a tiny self-contained build script, `scripts/build-docs.js`, that turns this tree into a navigable static HTML site in `docs-dist/`. Run `npm run docs:build` to regenerate it; CI runs the build on every push and fails if the committed `docs-dist/` is out of date. The script has no external dependencies — it embeds a small markdown renderer that covers the subset used in this tree (headings, fenced code, ordered/unordered lists with nesting, GFM tables, blockquotes, inline code, bold/italic/strikethrough, links, images).

## Index

<!-- New feature docs must be added here in the same commit that introduces them. -->

- [REST + SSE server](features/rest-and-sse-server.md) — baseline shipped in `v1.0.0`.
- [App and project settings](features/app-and-project-settings.md) — defaults → app SQLite store → per-project `.mouaif.json`, project wins.
- [Settings UI](features/settings-ui.md) — REST endpoints for global provider connections and project settings, plus the mobile Settings section in `/web/`.
- [Virtual list primitive](features/virtual-list.md) — windowed, recycled, no forced reflow. Powers the chat list and the inspector tree.
- [New-project folder picker](features/folder-picker.md) — list subdirs anywhere on the filesystem, create new folders, register projects.
- [Project card](features/project-card.md) — per-project card in the mobile UI: chat list (scrolling inside the card), New chat, options menu (rename / unregister), per-project rename endpoint. Chats persisted in `<projectDir>/.mouaif.json`.
- [Chat UI](features/chat-ui.md) — Preact + Vite mobile shell with chat, projects, inspector, and settings; provider authentication is integrated into Settings.
- [Model picker](features/model-picker.md) — chat-head popover for picking `(providerId, modelId)`; per-provider sections, search, ghost row for unavailable active model, and an actionable empty-state card.
- [PWA](features/pwa.md) — installable mobile shell: manifest, hand-rolled service worker (precache the shell, network-first for navigations, cache-first for fingerprinted assets, bypass `/api/*` and SSE), iOS Add-to-Home-Screen, offline + "new version" banners.
- [Inspector](features/inspector.md) — from-scratch mobile-friendly DevTools-style UI on top of CDP over WebSocket. Console + Network panels driven by a virtual list; targets list + connect flow. Mobile shell's fourth tab.
- [AI client](features/ai-client.md) — server-side proxy + SSE streaming for 6 providers (OpenAI-compatible, Anthropic, Gemini, Ollama, OpenRouter, GitHub Copilot reserved). Apikey only; OAuth lands in follow-up commits.
- [Auth](features/auth.md) — `@napi-rs/keyring` token store, loopback OAuth callback, non-secret account index. Per-provider sign-in lands in one commit per provider.
- [Anthropic OAuth](features/oauth-anthropic.md) — PKCE S256 browser flow against `platform.claude.com`, `Authorization: Bearer` on the Messages API, refresh-token grant, no-browser fallback.
- [OpenRouter](features/openrouter.md) — one API key, many models over an OpenAI-shaped endpoint. API key or PKCE sign-in (`https://openrouter.ai/auth`); the issued key is stored in the `openrouter` keyring namespace.
- [Custom prompts](features/custom-prompts.md) — user-authored system/role prompts stored per project, with per-chat prompt selector.
- [MCP](features/mcp.md) — Model Context Protocol servers as user tools. Per-project stdio server registry, tool discovery, in-chat tool_call/tool_result cards.
- [Chrome Debug MCP](features/chrome-debug-mcp.md) — preset `chrome-debug` MCP entry pairing the model with the same Chrome instance the Inspector tab talks to (port 9222).
- [Usage metrics](features/usage-metrics.md) — per-message cost in USD and live token speed rendered under each turn; pricing lives on the model record and in app settings, with sensible defaults.
- [File tagging](features/file-tagging.md) — annotate project files with tags, pin excerpts, and auto-inject them into new chat messages; tags live in the project's `.mouaif.json`.
- [Shell tool](features/shell-tool.md) — built-in `shell` tool the model can invoke; runs commands in the project directory and returns stdout / stderr / exit code / duration over SSE.
- [Tool authorization](features/tool-authorization.md) — per-project authorization gate (`off` / `ask` / `allowlist` / `allow`) for every tool call and every `/shell` composer command.
- [Native file tools](features/file-tools.md) — built-in `read_file`, `list_files`, `search_files`, `write_file` tools the model can call to find, read, and edit project files. Same authorization gate as `shell`.
- [Ask the user tool](features/ask-user-tool.md) — built-in `ask_user` tool the model can invoke to pause the chat and ask the user a structured question with 2-4 options. The user always has a free-form "extra answer" textarea alongside their pick, so the response is never constrained to the offered options. Binary authorization mode (`off` / `ask`).
- [Prompt-size profiles](features/prompt-profiles.md) — `very-small | average | extensive` system-prompt profiles resolved per chat, layered in front of any custom prompt and the transcript.
- [Agent skills](features/agent-skills.md) — project-scoped instruction files under `.agents/skills/*/SKILL.md`, injected into the upstream system context at stream time.
- [iOS touch scroll](features/ios-touch-scroll.md) — make the chat transcript touch-scrollable on iOS Safari by removing every overflow layer between the transcript and the document (no `overflow: hidden` on `.app__main--flush` or `.chat-view`); the transcript is the only scroll container in the tree.
- [Chat error surfacing](features/chat-error-surfacing.md) — failed turns are emitted over SSE, rendered as inline error bubbles, and persisted as system messages so they survive reloads.
- [Tool tree](features/tool-tree.md) — compact hierarchical checkbox list for tool visibility, shared across chat view, project settings, and authorization flows. Auto-checks tools used in the current chat.

## Architectural decisions

See [decisions.md](decisions.md) for the locked-in stack, storage, and build order.
