# mouaif — Architectural decisions

Resolved by `Ask questions for what's missin` on 2026-07-13. These choices are now binding for every subsequent `feat:` commit. Any change requires a new ADR-style note in this file and, if a commit has already shipped, a `refactor!:` or `fix:` commit that updates the relevant code and doc.

## 1. Settings storage — SQLite via `better-sqlite3`

- App-level settings live in `~/.mouaif/store.sqlite` (managed by `better-sqlite3`).
- Project-level settings still live in `<projectDir>/.mouaif.json` so they can be committed to a repo and edited by hand.
- New runtime dependency: `better-sqlite3` (^11). Add it in the settings commit.

## 2. Settings scope — project overrides app

- Resolution order: defaults → app → project. Project wins on conflict.
- Documented in `docs/features/app-and-project-settings.md`.

## 3. Models — slug key, no pre-made list

- A model is `{ id: slug, provider, label, baseUrl, apiKey, contextWindow, ... }`.
- Persisted in the app settings store. No built-in list, ever.

## 4. Projects — full filesystem browse

- Picker shows any directory the user has permission to read.
- Mobile UI must implement its own directory browser from day one (no native FS picker).

## 5. Trace-to-file — per-chat export to a project-relative file

The "trace to file" feature is a **user export**, not a background stream and not a chat-storage mechanism. It exists so a user can commit a chat's transcript next to the rest of the project source and treat it like any other file in the repo.

- **Scope: the chat the toggle is on.** Nothing is traced unless the user opts this chat in.
- **Trigger: per-chat toggle**, off by default. There is no app-wide or project-wide default; every chat starts untraced.
- **Path: `<projectDir>/.mouaif/traces/<chatId>.ndjson`.** Lives next to the project so it can be `git add`-ed with the rest of the source. If the chat has no project, the user is prompted to pick one before tracing starts (no surprise writes outside the project).
- **Format: NDJSON, one event per line, append-only.** Each line is one of `user message | assistant message | tool call | tool result | system event | error`, with `{ ts, type, ...payload }`. The filename identifies the chat, so the `chatId` is not duplicated on every line.
- **Lifecycle: while the toggle is on, every new event for the chat is appended.** Toggling off closes the file handle; the file is kept. Toggling on again opens it in append mode and continues. No rotation, no TTL, no auto-cleanup — the file is the user's source file.
- **Relationship to chat storage: independent.** The transcript of the chat is stored wherever the chat store decides (per decision 1, that will be the app SQLite store). The trace file is a *view* of that store, written out as a plain file. Deleting the trace file does not delete the chat; deleting the chat does not delete the trace file.
- **Export is also available without toggling.** The chat UI exposes a one-shot "Export trace" action that writes the same NDJSON shape to a path the user picks, without leaving the toggle on.

## 6. Inspector — Chrome DevTools Protocol (CDP) over WebSocket

- `mouaif` connects to a Chrome instance started with `--remote-debugging-port`.
- New runtime dependency: a CDP client (decided per implementation commit; the lightweight choice is `chrome-remote-interface`).
- The mobile UI is still from-scratch — it consumes CDP events but never embeds the Chrome panel.

## 7. UI scaffold — Preact + Vite

- Build tool: Vite.
- Framework: Preact (`~3 KB`), with `@preact/signals` for the virtual list and the inspector tree.
- Mobile-first via CSS + `env(safe-area-inset-*)`.

## 8. Web serving — served by `mouaif serve` at `/web/`

- The existing Node server on port `5732` gains a `GET /web/...` route that serves the built mobile UI bundle.
- One process, one port. CORS stays permissive.
- Vite builds into `src/web/dist/`. The dev flow is `npm run build:web` then `mouaif serve`.

## 9. Build order — settings first

- The next `feat:` commit implements app + project settings (decisions 1 + 2) and ships with `docs/features/app-and-project-settings.md`.
- After that: virtual list primitive → models → folder picker → **AI client core (4 providers + Copilot, key-only, server proxy, SSE — covers OpenAI via the `openai-compatible` provider with an API token, plus Anthropic, Gemini, Ollama, and GitHub Copilot reserved) → auth (keytar + per-model auth + loopback callback skeleton) → Anthropic OAuth → Google OAuth → GitHub Copilot OAuth → trace → project card → custom prompts → grouped chat list → prompt-size profiles → tabbed mobile UI shell → custom DevTools-style inspector**.

## 10. AI client — server-side proxy with SSE streaming

- The mobile UI never holds an API key. All provider calls go through `POST /api/ai/chat` on the mouaif server, which streams the response back over SSE.
- Provider set, this commit: `openai-compatible`, `anthropic`, `gemini`, `ollama`, `github-copilot`. The first four are key-only in this commit; `github-copilot` is documented but its auth lands with the OAuth commits.
- Model record is extended to `{ id, provider, label, baseUrl, apiKey, auth: 'apikey' | 'oauth', oauthAccount?: string, contextWindow }`. Additive — existing models without `auth` are treated as `'apikey'`.
- Streaming protocol: each upstream event is converted to an SSE event of the same name. The UI receives `event: message` for content deltas, `event: tool_call` / `event: tool_result` (later commits), and `event: done` when the response is complete. `event: error` carries a typed code.
- 5xx from the upstream becomes an SSE `error` event; the connection is then closed. The chat UI is expected to surface the typed code.

## 11. Auth — @napi-rs/keyring token store + per-model auth + loopback callback

- OAuth tokens live in the OS keychain via `@napi-rs/keyring` (a napi-rs binding to `keyring-rs`, cross-platform: Windows Credential Manager, macOS Keychain, Linux Secret Service / libsecret). Chosen over `keytar` because keytar is unmaintained and rebuilds frequently fail on modern Node. New runtime dependency.
- App settings keep a non-secret index of `{ provider, account }` so the UI can list "logged in as ..." without touching the keychain.
- Loopback callback: `mouaif serve` exposes `GET /oauth/callback` on the same port. The user does the login in their system browser; the provider redirects back to the local server; the server exchanges the code, stores the token in the keyring, and the UI polls `GET /api/auth/status?provider=...` to learn when login finished.
- Per-model auth: a model with `auth: 'oauth'` is resolved to the matching `oauthAccount`; if missing, the proxy returns a typed `ENOAUTH` error and the UI prompts to sign in.

## 12. OAuth — one provider per commit

- Each provider that exposes an OAuth flow for third-party clients gets its own `feat:` commit and its own `docs/features/oauth-<provider>.md`. Commits: Anthropic → Google → GitHub Copilot.
- Each commit reuses the loopback callback skeleton from decision 11; only the authorization endpoint, token endpoint, client id, and scopes differ.
- OpenAI's public API is on the token (API key) path and is already covered by the AI client core commit (decision 10, `openai-compatible` provider). It does not appear in this OAuth list.

