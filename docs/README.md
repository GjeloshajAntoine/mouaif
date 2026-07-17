# mouaif — Feature documentation

Static-page-ready docs for every feature in mouaif. Each file in `features/` is a self-contained page that can be rendered with any static site generator (GitHub Pages, VitePress, Docusaurus, plain HTML).

## Index

<!-- New feature docs must be added here in the same commit that introduces them. -->

- [REST + SSE server](features/rest-and-sse-server.md) — baseline shipped in `v1.0.0`.
- [App and project settings](features/app-and-project-settings.md) — defaults → app SQLite store → per-project `.mouaif.json`, project wins.
- [Settings UI](features/settings-ui.md) — REST endpoints for global provider connections and project settings, plus the mobile Settings section in `/web/`.
- [Virtual list primitive](features/virtual-list.md) — windowed, recycled, no forced reflow. Powers the chat list and the inspector tree.
- [New-project folder picker](features/folder-picker.md) — list subdirs anywhere on the filesystem, create new folders, register projects.
- [Project card](features/project-card.md) — per-project card in the mobile UI: chat list (scrolling inside the card), New chat, options menu (rename / unregister), per-project rename endpoint. Chats persisted in `<projectDir>/.mouaif.json`.
- [Chat UI](features/chat-ui.md) — Preact + Vite mobile shell with chat, projects, inspector, and settings; provider authentication is integrated into Settings.
- [Inspector](features/inspector.md) — from-scratch mobile-friendly DevTools-style UI on top of CDP over WebSocket. Console + Network panels driven by a virtual list; targets list + connect flow. Mobile shell's fourth tab.
- [AI client](features/ai-client.md) — server-side proxy + SSE streaming for 6 providers (OpenAI-compatible, Anthropic, Gemini, Ollama, OpenRouter, GitHub Copilot reserved). Apikey only; OAuth lands in follow-up commits.
- [Auth](features/auth.md) — `@napi-rs/keyring` token store, loopback OAuth callback, non-secret account index. Per-provider sign-in lands in one commit per provider.
- [Anthropic OAuth](features/oauth-anthropic.md) — PKCE S256 browser flow against `platform.claude.com`, `Authorization: Bearer` on the Messages API, refresh-token grant, no-browser fallback.
- [OpenRouter](features/openrouter.md) — one API key, many models over an OpenAI-shaped endpoint. API key or PKCE sign-in (`https://openrouter.ai/auth`); the issued key is stored in the `openrouter` keyring namespace.
- [Custom prompts](features/custom-prompts.md) — user-authored system/role prompts stored per project, with per-chat prompt selector.
- [MCP](features/mcp.md) — Model Context Protocol servers as user tools. Per-project stdio server registry, tool discovery, in-chat tool_call/tool_result cards.
- [Usage metrics](features/usage-metrics.md) — per-message cost in USD and live token speed rendered under each turn; pricing lives on the model record and in app settings, with sensible defaults.
- [File tagging](features/file-tagging.md) — annotate project files with tags, pin excerpts, and auto-inject them into new chat messages; tags live in the project's `.mouaif.json`.
- [Shell tool](features/shell-tool.md) — built-in `shell` tool the model can invoke; runs commands in the project directory and returns stdout / stderr / exit code / duration over SSE.
- [Tool authorization](features/tool-authorization.md) — per-project authorization gate (`off` / `ask` / `allowlist` / `allow`) for every tool call and every `/shell` composer command.
- [Native file tools](features/file-tools.md) — built-in `read_file`, `list_files`, `search_files`, `write_file` tools the model can call to find, read, and edit project files. Same authorization gate as `shell`.
- [Prompt-size profiles](features/prompt-profiles.md) — `very-small | average | extensive` system-prompt profiles resolved per chat, layered in front of any custom prompt and the transcript.

## Architectural decisions

See [decisions.md](decisions.md) for the locked-in stack, storage, and build order.
