# mouaif — Feature documentation

Static-page-ready docs for every feature in mouaif. Each file in `features/` is a self-contained page that can be rendered with any static site generator (GitHub Pages, VitePress, Docusaurus, plain HTML).

## Index

<!-- New feature docs must be added here in the same commit that introduces them. -->

- [REST + SSE server](features/rest-and-sse-server.md) — baseline shipped in `v1.0.0`.
- [App and project settings](features/app-and-project-settings.md) — defaults → app SQLite store → per-project `.mouaif.json`, project wins.
- [Settings UI](features/settings-ui.md) — REST endpoints for models CRUD and key reset, plus the mobile Settings section in `/web/`.
- [Virtual list primitive](features/virtual-list.md) — windowed, recycled, no forced reflow. Powers the chat list and the inspector tree.
- [New-project folder picker](features/folder-picker.md) — list subdirs anywhere on the filesystem, create new folders, register projects.
- [AI client](features/ai-client.md) — server-side proxy + SSE streaming for 5 providers (OpenAI-compatible, Anthropic, Gemini, Ollama, GitHub Copilot reserved). Apikey only; OAuth lands in follow-up commits.
- [Auth](features/auth.md) — `@napi-rs/keyring` token store, loopback OAuth callback, non-secret account index. Per-provider sign-in lands in one commit per provider.
- [Anthropic OAuth](features/oauth-anthropic.md) — PKCE S256 browser flow against `platform.claude.com`, `Authorization: Bearer` on the Messages API, refresh-token grant, no-browser fallback.

## Architectural decisions

See [decisions.md](decisions.md) for the locked-in stack, storage, and build order.
