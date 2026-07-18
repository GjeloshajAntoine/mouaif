# mouaif 🚀

A CLI tool with an integrated HTTP server, an in-app project picker, and a mobile-first web UI. The CLI serves a single Node process on `http://127.0.0.1:5732` that exposes a REST + SSE surface for AI chat, project management, settings, and auth. The mobile UI at `/web/` is a Preact + Vite bundle that talks to the server over the same origin — no API key ever leaves the box.

## What you get

- **CLI**: `mouaif serve` (port 5732 by default), `mouaif info`.
- **HTTP server**: REST + SSE. SSE for chat streaming (`POST /api/chats/:id/messages/stream`).
- **Mobile UI** at `http://127.0.0.1:5732/web/`: projects, chats, settings, sign-in. Preact + Vite, served by the same Node process. No framework-specific state layer — `@preact/signals` only.
- **Storage**: app-level settings in `~/.mouaif/store.sqlite` (better-sqlite3). Per-project settings + chats in `<projectDir>/.mouaif.json`. Per-chat transcripts in `<projectDir>/.mouaif.messages.<chatId>.json`. Trace streams in `<projectDir>/.mouaif/traces/<chatId>.ndjson`.
- **Auth**: API keys live in the app SQLite store. OAuth tokens live in the OS keychain via `@napi-rs/keyring` (Windows Credential Manager / macOS Keychain / Linux Secret Service). A loopback callback at `GET /oauth/callback` completes provider sign-in; the UI polls `/api/auth/status` until the account is visible.
- **Five AI providers** in the AI client: `openai-compatible`, `anthropic`, `gemini`, `ollama`, `github-copilot`. The first four are apikey-only in the bundled build; Anthropic supports OAuth via a per-provider flow. Copilot is reserved (auth flow lands in a follow-up).

## Quick start

```bash
git clone <repo-url>
cd mouaif
npm install
npm link                  # puts `mouaif` on your PATH
npm run build:web         # build the mobile UI into src/web/dist/
mouaif serve              # http://127.0.0.1:5732
```

Open `http://127.0.0.1:5732/web/` on your phone (or any browser, mobile-first). Tap **+ Add project** to pick a folder, configure a provider in **Settings**, then define that project's model IDs in its `.mouaif.json`. The models appear in the chat picker; send a message and the response streams back over SSE.

## CLI commands

```bash
mouaif serve               # start the HTTP server (default port 5732)
mouaif serve --watch       # restart when local source files change
mouaif serve -p 9000       # custom port
mouaif info                # show package version + default port
```

The server is a single Node process. CORS is permissive so the same `127.0.0.1:5732` origin can serve both the API and the mobile UI without preflight.

## HTTP surface

A live self-description lives at `GET /` and lists every route. Highlights:

| Surface | Routes |
|---|---|
| Settings | `GET /api/settings`, `GET /api/settings/resolved?projectDir=…`, `GET /api/settings/project?projectDir=…`, `PUT /api/settings/app`, `PUT /api/settings/project`, `POST /api/settings/app/providers`, `DELETE /api/settings/app/providers/:id`, `POST /api/settings/app/reset` |
| Projects | `GET /api/projects?dir=…`, `POST /api/projects` (actions: `list`, `create`, `register`), `GET /api/projects/registered`, `DELETE /api/projects/registered/:id`, `PATCH /api/projects/registered/:id` |
| Chats | `GET /api/chats?projectDir=…`, `POST /api/chats`, `GET/PATCH/DELETE /api/chats/:id`, `POST /api/chats/:id/touch`, `GET/POST/DELETE /api/chats/:id/messages`, `POST /api/chats/:id/messages/stream` (SSE) |
| AI | `GET /api/ai/models?projectDir=…`, `POST /api/ai/chat` (SSE) |
| Auth | `GET /api/auth/accounts`, `GET /api/auth/status?provider=…`, `DELETE /api/auth/accounts/:provider/:account`, `POST /api/auth/sign-in/anthropic` |
| OAuth | `GET /oauth/callback` (browser redirect), `POST /oauth/callback` (no-browser fallback) |
| Mobile UI | `GET /web/` (serves `src/web/dist/`, falls back to `src/web/` for dev) |

The chat stream is the hot path: a single round-trip per user turn. The server appends the user message, calls the upstream provider, streams `message` / `done` / `error` events back as SSE, and appends the assistant message on `done`. If the chat's `trace` flag is on, every event is also written to `<projectDir>/.mouaif/traces/<chatId>.ndjson`.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `MOUAIF_HOME` | `~/.mouaif` | App-level SQLite + state root. |
| `MOUAIF_ALLOW_ANY_ROOT` | unset | When `1`, allows `/api/projects` paths outside the user home. |
| `MOUAIF_ANTHROPIC_API_BASE` | `https://api.anthropic.com` | Anthropic token endpoint (test override). |

## Mobile UI

The Preact + Vite bundle is mobile-first: 360–430 px primary viewport, 44 × 44 px touch targets, system font stack, safe-area aware, no hover-only affordances. The top-level views are Projects, Inspector, and Settings. Settings contains provider connections, authentication, and project overrides; the old `#/auth` route redirects there.

## Documentation

Every shipped feature has a static-page-ready doc in [docs/features/](docs/features/) and the locked-in stack is in [docs/decisions.md](docs/decisions.md). New features land in the same commit as their docs and a one-line entry in [docs/README.md](docs/README.md).

## Project structure

```
mouaif/
├── bin/mouaif.js             # CLI entry (commander)
├── src/
│   ├── index.js              # HTTP server: REST + SSE routing
│   ├── ai.js                 # Server-side AI client (5 providers + SSE proxy)
│   ├── auth.js               # OS keychain wrapper + per-provider exchange registry
│   ├── oauth-anthropic.js    # Anthropic OAuth flow (PKCE S256)
│   ├── settings.js           # App + project settings store
│   ├── projects.js           # Filesystem browse + registered projects
│   ├── chats.js              # Per-project chat list
│   ├── messages.js           # Per-chat transcript
│   ├── trace.js              # Per-chat NDJSON trace writer
│   └── web/                  # Preact + Vite mobile UI
│       ├── index.html
│       ├── vite.config.js
│       ├── src/              # main.jsx, style.css, virtual-list.js
│       └── dist/             # build output (committed for `mouaif serve`)
├── docs/                     # decisions.md, features/*.md
└── package.json
```

## License

MIT
