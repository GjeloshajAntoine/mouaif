# mouaif — Architectural decisions

Resolved by `Ask questions for what's missin` on 2026-07-13. These choices are now binding for every subsequent `feat:` commit. Any change requires a new ADR-style note in this file and, if a commit has already shipped, a `refactor!:` or `fix:` commit that updates the relevant code and doc.

## 1. Settings storage — SQLite via `better-sqlite3`

- App-level settings live in `~/.mouaif/store.sqlite` (managed by `better-sqlite3`).
- Project-level settings still live in `<projectDir>/.mouaif.json` so they can be committed to a repo and edited by hand.
- New runtime dependency: `better-sqlite3` (^11). Add it in the settings commit.

## 2. Settings scope — project overrides app

- Resolution order: defaults → app → project. Project wins on conflict.
- Documented in `docs/features/app-and-project-settings.md`.

## 3. Providers and models — separate scopes; live list per provider

- A provider connection is `{ id, baseUrl, apiKey, auth, oauthAccount? }` and is persisted in the app SQLite store. It owns transport and credentials.
- A model is `{ id: slug, provider, label?, contextWindow?, ... }` and is defined in project settings. `provider` references an app-level provider connection.
- Provider credentials are never written to project files. At request time, the server hydrates the selected project model with its matching app-level provider connection.
- **The chat <select> is populated from a live catalog** that each provider exposes:
  - OpenAI-compatible → `GET {baseUrl}/models` (OpenAI-shaped)
  - Anthropic → curated catalog (no public list endpoint with API-key auth)
  - Gemini → `GET /v1beta/models` (filtered to `generateContent`); key optional
  - Ollama → `GET /api/tags` (local, no auth)
  - GitHub Copilot → curated catalog (no public list endpoint)
  - OpenRouter → `GET /api/v1/models` (OpenAI-shaped); key optional
- The project `models` array (when present) is merged with the live list, so user-defined slugs stay. The chat <select> shows the union, deduped by id.
- The chat selects the provider explicitly from configured app connections. It never falls back silently to the first connection when the project has no models; the selected `providerId` + `modelId` pair is stored on the chat and restored on reopen. A live-catalog send carries `{ modelId, providerId }`, allowing the server to hydrate a transient model record without writing the full catalog into project settings.
- Results are cached per `${provider}:${credHash}` for 1 hour on the server. The chat head has a refresh button that re-fetches the live list for the current provider.

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

## 8. Web serving — served by `mouaif serve` at `/` (frontend at the repo root)

- The Node server on port `5732` serves the built mobile UI at the root `/` (no `/web/` prefix). A legacy `/web/` route 301-redirects to `/` so old bookmarks keep resolving (the hash fragment is preserved, so `/web/#/chat/<id>` lands on `/#/chat/<id>`). Old **installed** PWAs from before this move are *not* upgraded in place: the previous install declared `id`/`scope`/`start_url` of `/web/`, and the 301 leaves that scope, so the browsers/OS drop standalone mode and open a normal browser tab. Those users must delete and re-add the PWA (see `docs/features/pwa.md` → Migration).
- One process, one port. The UI and API are same-origin. The default listener is `127.0.0.1`; browser API requests require the HttpOnly session cookie issued by `/`, and cross-origin requests are rejected.
- The frontend does **not** live inside the backend tree. It lives at the repo root in `frontend/` (`frontend/vite.config.js`, `frontend/index.html`, `frontend/src/`, `frontend/public/`, `frontend/build/`). Vite builds it into `frontend/dist/`; the server serves that directory (falling back to the pre-build `frontend/` source for development) via `src/server-web-static.js`. The dev flow is `npm run build:web` then `mouaif serve`.
- The root-scoped service worker (`/sw.js`, `Service-Worker-Allowed: /`) strictly bypasses every live API surface (`/api/*`, `/events`, `/data`, `/oauth/*`) — see `docs/features/pwa.md`.

## 9. Build order — settings first

- The next `feat:` commit implements app + project settings (decisions 1 + 2) and ships with `docs/features/app-and-project-settings.md`.
- After that: virtual list primitive → models → folder picker → **AI client core (4 providers + Copilot, key-only, server proxy, SSE — covers OpenAI via the `openai-compatible` provider with an API token, plus Anthropic, Gemini, Ollama, and GitHub Copilot reserved) → auth (@napi-rs/keyring + per-model auth + loopback callback skeleton) → Anthropic OAuth → trace → project card → custom prompts → grouped chat list → prompt-size profiles → tabbed mobile UI shell → custom DevTools-style inspector → OpenRouter provider (apikey-only, OpenAI-shaped, shares the `openai` keyring namespace with the openai-compatible family) → OpenRouter PKCE sign-in (the OpenRouter provider now also accepts an OAuth/PKCE sign-in; the issued key is stored in a dedicated `openrouter` keyring namespace added to `SUPPORTED_PROVIDERS`)**.

## 10. AI client — server-side proxy with SSE streaming

- The mobile UI never holds an API key. All provider calls go through `POST /api/ai/chat` on the mouaif server, which streams the response back over SSE.
- Provider set, this commit: `openai-compatible`, `anthropic`, `gemini`, `ollama`, `github-copilot`. The first four are key-only in this commit; `github-copilot` is documented but its auth lands with the OAuth commits. `openrouter` is the sixth provider — OpenAI-shaped, apikey-only, reuses the openai-compatible builder and parser, and stores its key in the `openai` keyring namespace so users do not have to manage a separate credential store. Later commits add four more OpenAI-shaped API-key providers — `azure` (deployment-URL base + `api-version` query, `api-key` header), `mistral`, `groq`, `deepseek` (Bearer keys) — each with its own keyring namespace, so the provider set is now ten: `openai-compatible`, `anthropic`, `gemini`, `ollama`, `github-copilot`, `openrouter`, `azure`, `mistral`, `groq`, `deepseek`.
- At request time, project-owned metadata (`id`, `provider`, `label`, context/pricing limits) is combined with the referenced app provider. Transport and credential fields (`baseUrl`, `apiKey`, `auth`, `oauthAccount`, headers, tokens) always come from the app connection; project JSON cannot override them.
- Streaming protocol: each upstream event is converted to an SSE event of the same name. The UI receives `event: message` for content deltas, `event: tool_call` / `event: tool_result` (later commits), and `event: done` when the response is complete. `event: error` carries a typed code.
- 5xx from the upstream becomes an SSE `error` event; the connection is then closed. The chat UI is expected to surface the typed code.

## 11. Auth — @napi-rs/keyring token store + per-model auth + loopback callback

- OAuth tokens live in the OS keychain via `@napi-rs/keyring` (a napi-rs binding to `keyring-rs`, cross-platform: Windows Credential Manager, macOS Keychain, Linux Secret Service / libsecret). Chosen over `keytar` because keytar is unmaintained and rebuilds frequently fail on modern Node. New runtime dependency.
- App settings keep a non-secret index of `{ provider, account }` so the UI can list "logged in as ..." without touching the keychain.
- Loopback callback: `mouaif serve` exposes `GET /oauth/callback` on the same port. The user does the login in their system browser; the provider redirects back to the local server; the server exchanges the code, stores the token in the keyring, and the UI polls `GET /api/auth/status?provider=...` to learn when login finished.
- Per-model auth: a model with `auth: 'oauth'` is resolved to the matching `oauthAccount`; if missing, the proxy returns a typed `ENOAUTH` error and the UI prompts to sign in.

## 12. OAuth — one provider per commit

- Each provider that exposes an OAuth flow for third-party clients gets its own `feat:` commit and its own `docs/features/oauth-<provider>.md`. Anthropic is the one provider on this list.
- Each commit reuses the loopback callback skeleton from decision 11; only the authorization endpoint, token endpoint, client id, and scopes differ.
- OpenAI's public API is on the token (API key) path and is already covered by the AI client core commit (decision 10, `openai-compatible` provider). It does not appear in this OAuth list.

## 13. Proactive OAuth refresh

- The AI client (`src/ai.js → requireApiKey`) inspects the stored access token's `expiresAt` before every chat. If the token is within `OAUTH_REFRESH_LEAD_MS` (60s) of expiry (or already past) and a `refresh_token` is on file, the client invokes the provider's registered refresher and persists the new blob back to the keychain. The outbound request uses the new access token, so a long chat never hits a 401 mid-stream.
- Refreshers are registered with `auth.registerRefresher(provider, fn)`, the same shape as the existing `auth.registerExchange(provider, fn)`. The fn signature is `({ provider, account, refreshToken, scope, baseUrl }) -> { accessToken, refreshToken?, expiresAt?, scope?, account? }`. Persistence of the new blob is the refresh path's responsibility; the AI client just consumes the result.
- Failure mode: a refresh that throws is caught and swallowed; the chat falls through to the stored access token. The upstream's clean 401 is the recovery signal. We don't surface refresh failures to the chat UI as a hard error because (a) the token may still be valid for a few seconds, and (b) a flaky refresh should not block every chat past the lead window.
- Anthropic wires this via `oauthAnthropic.refresh` (registered in `oauthAnthropic.register()`). Other providers register their own. The 60s lead matches the SDK's typical advisory-refresh threshold.
- The model record's `auth: 'oauth'` is the gate. `auth: 'apikey'` models skip this path entirely.

## 14. Usage metrics — per-message cost and live token speed in the chat

- Every chat turn already carries a `usage` block (`{ promptTokens, completionTokens }`) on the `done` event from the AI client (decision §10). The chat UI uses that block to render a per-message **cost** (in USD) and a **live tokens/s** counter that ticks under the user turn as the assistant's deltas arrive.
- Pricing is opt-in: a per-model `pricing` map (`{ inputPer1K, outputPer1K }` in USD) lives on the project model record. Missing values fall back to `app.modelPricing[<modelId>]`, then to a small built-in table for known model ids, then to `--`. The Settings UI lets the user edit the app-level table without touching JSON.
- The counter is purely client-side: the chat UI hooks the existing `message` and `done` SSE callbacks. The token/s formula is `completionTokensDelivered / streamingMs`, with the window starting on the first delta of the turn and stopping on `done` (or on the last delta before `error` / `EABORTED`).
- The full `usage` block is persisted on the assistant message (decision §10) and is written to the per-chat NDJSON trace as a `done` event (decision §5), so the cost and speed are reproducible from the trace alone.
- Pricing is informational, not transactional. A wrong `pricing` entry produces a wrong number on the cost line; it does not affect what the upstream charges. Currency is USD only; the format layer respects the user's locale decimal separator.
- New module: `src/usage.js`. No new runtime dependencies, no new SSE events, no new endpoints.

## 15. File tagging — annotate project files and inject them into a chat

- A user can attach **tags** to files inside a project. Tags live in `<projectDir>/.mouaif.json` under a new top-level `tags` key, shaped as `{ "<relPath>": { tags: [...], excerpt: {start,end} | null, includeInChat: true } }`. The map is committed with the project and editable by hand.
- Path normalization is POSIX-relative to the project root. The injection loader resolves paths with `path.join(projectDir, rel)` and refuses anything that escapes the project root (`..` segments, absolute paths, symlinks that point outside) with `EOUTSIDE_PROJECT`.
- When the user sends a chat, the server pre-appends every tagged file with `includeInChat: true` to the upstream `messages` array, before the custom prompt and the transcript. The synthetic message shape is:
  ```js
  { role: 'system',
    content: '# File: <relPath>\n# Tags: <csv>\n# Excerpt: <a>-<b>\n\n<file body or excerpt>' }
  ```
  An explicit `@<relPath>` in the composer promotes the synthetic message to `role: 'user'`.
- File size cap (`app.fileTagMaxBytes`, default 256 KB) hides the body of oversized files; the entry stays in the project file with `includeInChat: false` and a `note`. A smaller excerpt bypasses the cap.
- Stale paths (moved, renamed, deleted) are kept in the project file with a `missing` badge and skipped at injection time. The UI offers a "Remove" action.
- The scan endpoint is a one-pass directory walk honoring the same home-allowlist rules as the folder picker (decision §4). Binary files are filtered by extension; the default extension allowlist is text-friendly (`.js .jsx .ts .tsx .mjs .cjs .json .json5 .md .txt .py .rb .go .rs .java .kt .swift .c .h .cpp .hpp .css .scss .less .html .vue .svelte .astro .yml .yaml .toml .sh .sql .graphql .gql .proto .ini .conf .cfg .env .lock .map .log .lua .pl .pm .r .jl .dart .zig .ex .exs .erl .hrl .fs .fsx .ml .clj .cljs .scala .groovy .gradle .tf .hcl .pug .jade .ejs .hbs .mustache .tpl .gitignore .gitattributes .editorconfig .eslintrc .prettierrc .babelrc .npmrc .nvmrc .yarnrc .dockerignore .gitmodules .htaccess .dockerfile .makefile`). The check is against the file's **extension**, never the whole name, so dotted base names (`App.vue`, `webpack.config.js`) are never mistaken for extensionless binaries; extensionless build files (`Makefile`) are classified via the allowlist too.
- The basename `@`-reference pass resolves against the **on-disk scan plus the tagged map** (a mention can target any file in the project, tagged or not). The scan returns objects, so the pass maps them to `path` strings before matching.
- New module: `src/tags.js`. New REST surface: `GET/PUT /api/projects/<id>/tags`, `POST /api/projects/<id>/tags/scan`, `DELETE /api/projects/<id>/tags/files/*`. The injection happens in `src/index.js → handleChatStream` immediately before the existing `promptId` block.

## 22. Chat storage — SQLite by default, JSON files as a legacy option

- Chat metadata and messages are stored in the same app-level SQLite store (`~/.mouaif/store.sqlite`) used for settings, in two new tables: `chat_store` and `message_store`.
- File-based storage (`.mouaif.messages.*.json` files) is still available via the `chatStorage` app setting (`'db'` | `'json'`, default `'db'`). Switching back to JSON does not migrate existing DB data.
- A migration (`2025-07-23-import-chats-to-db`) runs on every `mouaif serve` start and imports any existing JSON files into the DB. Idempotent: already-imported chats are skipped.
- A manual import is available via `POST /api/chats/import`, the `mouaif import-chats` CLI command, and a "Import chats" button in project settings.
- Messages are stored with a composite PK `(project_dir, chat_id, seq)` so the same project-chat ordering is preserved across backends. The `seq` column is auto-incremented per chat.
- The `chatStorage` toggle is resolved per-project via `settings.getResolved(projectDir)` so individual projects could theoretically opt back to JSON while others use the DB. In practice the setting is app-wide, but the resolution chain supports per-project override.

## 16. Shell tool — let the model run commands in the project

- `mouaif` ships a built-in `shell` tool the model can invoke. The tool runs a command in `projectDir` via `node:child_process.spawn`, captures stdout / stderr / exit code / duration, and returns the result to the model. The model-facing tool spec uses the OpenAI-compatible function-call shape; the runner is invoked on the server and is the only path that actually executes.
- Calls and results ride the chat as `tool_call` and `tool_result` SSE events (decision §10) and are persisted with the transcript and written to the per-chat NDJSON trace (decision §5) as `tool_call` / `tool_result` lines.
- The command runs in `projectDir` with the user's login shell (`$SHELL` on POSIX, `cmd.exe` on Windows). The runner resolves the path and refuses anything outside the project root with `EOUTSIDE_PROJECT`. The child inherits the parent env minus a small denylist (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`).
- Default per-call timeout: 30 s. Ceiling: 10 min. On timeout the child is killed (SIGTERM, then SIGKILL after 5 s) and the result is `{ ok: false, code: 'ETIMEDOUT' }`.
- stdout / stderr are truncated to `app.shellOutputMaxBytes` (default 256 KB each). The original exit code is preserved.
- The tool is **off by default per project**. A project with the tool off returns `ETOOL_DISABLED` for any call (model-initiated or `/shell`). The composer `/shell <cmd>` slash command uses the same runner.
- The runner is built on `node:child_process`; no third-party shell wrappers, no new runtime dependencies. Child processes are tracked in a `Set` and reaped on parent exit so a server shutdown does not leak zombies.
- New module: `src/tools/shell.js`. The model-facing tool spec is registered in `src/ai.js` next to `ENDPOINTS`; the runner is invoked from a new `toolRunner` registry, also in `src/ai.js`. New REST endpoint: `POST /api/tools/shell`.

## 17. Tool authorization — gating what tools the model may run

- Every tool call the model initiates — and every `/shell` slash command the user types — passes through an authorization gate before the runner executes. The gate is per-project, per-tool, per-session.
- Four modes: `off` (ETOOL_DISABLED, runner never runs), `ask` (every call must be approved by the user), `allowlist` (calls whose `cmd` matches an allowlist regex run without prompting; the rest fall through to `ask`), `allow` (every call in the session is auto-approved until the chat is reopened or the user flips back to `ask`).
- The default for new tools is `ask`, so the model can only run a command after the user has explicitly approved it (or a matching allowlist rule).
- The mode lives on the project record (decision §2) as `tools.<name>.mode` with `allowlist`, `defaultTimeoutMs`, and `maxTimeoutMs`. Missing values fall back to `app.tools.<name>`, then to `off`. A future revision may add a "remember for this project" toggle; for this commit session-scoping is the rule.
- Allowlist matches are full-string regex (`^...$`); catastrophic backtracking is mitigated by a 1 ms match timeout enforced in the runner.
- The chat pauses on `ask` and renders an **Authorization required** card with the command, working dir, timeout, and a "review trace" link when tracing is on. The user can tap **Allow once**, **Allow for this session** (records `chat.toolGrants[name] = { mode: 'allow', grantedAt }`), or **Deny**. The deny records the call id in `chat.toolGrants[name].deniedCallIds` so the same call id is not re-asked within the session.
- Deny reasons are kept private: the `tool` message forwarded to the upstream is `{ ok: false, code: 'EDENIED', reason: 'user denied' }` with no command, project, or chat id.
- Authorization is independent of the tool's enable switch. The runner's order is: enabled? → mode? → allowlist? → execute. Mode changes are not retroactive: flipping from `allow` to `ask` revokes the blanket grant and the next call is asked again; flipping to `off` rejects the next call with `ETOOL_DISABLED`.
- Every decision is appended to the per-chat NDJSON trace (decision §5) as a `system event` line (`{ type: 'auth_decision', tool, callId, decision }`) when tracing is on. The audit line is not forwarded to the upstream.
- New module: `src/tools/authorization.js`. The runner calls `authorize(...)` as the first line of its hot path; a `{ prompt: true }` decision blocks the runner until the UI posts a `decision` event on the same SSE stream. New REST surface: `GET/PUT /api/tools/authorization`, `POST /api/tools/authorization/decision`.

## 18. MCP — Model Context Protocol servers as user tools

- `mouaif` ships an **MCP client** that talks to any Model Context Protocol server the user configures. MCP servers are the third-party tool ecosystem (Filesystem, Git, Postgres, Playwright, custom internal tools) — they speak a single JSON-RPC-over-stdio protocol and advertise their tools. The AI client surfaces the server's `tools/list` as part of the model's tool set, intercepts `tool_call` events, dispatches them to the running MCP server, and feeds the result back as a `tool` message.
- A server is configured **at the project level** (originally `.mouaif.json`, later `.mcp.json`) under a new `mcp.servers` array. Each entry is `{ id, name, command, args?, env?, cwd?, source }` where `command` is the executable to spawn, `args` is the arg list, and `env` is a per-server env-var map merged on top of the parent env (decision §16 denylist still applies). An early `enabled` flag (off by default, mirroring the shell tool) was **later removed** — configured servers are always on, so the AI client can start any of them.
- Server lifecycle: `mcp.start(projectDir, serverId)` spawns the child process, opens a stdio JSON-RPC session, sends `initialize`, and discovers the server's tool list. The discovery result is cached on the server record so repeated chats don't re-spawn. `mcp.stop(projectDir, serverId)` kills the child and clears the cache. Servers are stopped on `process.exit`. Tools are advertised to the model as `{ name: 'mcp__<serverSlug>__<toolName>', description, parameters }` (the double-underscore is the standard MCP convention so model output stays unambiguous).
- Tool dispatch: when the upstream emits a `tool_call` whose `name` matches `mcp__<serverSlug>__<toolName>`, the AI client calls `mcp.callTool(projectDir, serverSlug, toolName, args)`, which writes a `tools/call` JSON-RPC request over the server's stdio and reads the response. The result is wrapped as `{ ok, content: [...], isError? }` and forwarded as a `tool` message. Errors from the server (JSON-RPC error codes, transport failures, server crashes) become typed `EMCP_TRANSPORT`, `EMCP_RPC`, or `ETIMEDOUT` results — the model sees a structured `tool_result` and can recover.
- Authorization: a layered per-project gate (default `ask`, same enum as decision §17) gates every MCP tool call, persisted in `.mcp.json` under `authorization`. Most specific wins: `authorization.tools.<composedName>` (one tool) → `authorization.servers.<serverSlug>` (one server) → the top-level `authorization` mode (shared fallback). `ask` counts as a decision at any layer, so a per-server `ask` can tighten a shared `allow`; a `null` entry clears the override. The existing authorization module is reused; the allowlist matches against the summary `"<composedName> <firstStringArg>"`. "Always allow" on an MCP prompt pins only that one tool (`authorization.tools.<name>.mode = "allow"`), never the shared gate. Server startup is **not** gated — it is the user's explicit "I added this server" decision that authorizes the lifecycle. A crash in the server process is treated as `ETOOL_DISABLED` for the rest of the chat and re-armed on next chat open.
- Persistence: server entries live in `<projectDir>/.mouaif.json` (so they can be committed with the project) but the actual child process and tool cache are in-memory only — they restart on server boot. The Settings UI lists the configured servers with their live status (stopped / starting / ready / errored), lets the user add / remove / start / stop, and surfaces the discovered tool list on tap. There is no separate per-server `enabled` field; the per-server authorization mode is the enable gate — `off` disables a server (never startable, tools hidden), anything else leaves it enabled and startable on demand.
- On-demand lifecycle: opening a chat never auto-starts a configured MCP server. `ensureServersRunning` (the `/api/tools/list` status path) is a pure reporter — it spawns nothing. A server starts the first time the model calls one of its tools (`callTool` starts it transparently within the same awaited call, only for an enabled server; a disabled `off` server throws `ETOOL_DISABLED`) or when the user taps the reload/Start control. This removes the historical cold-start stall on chat open while keeping every enabled server's persisted tool surface visible so the model can still call into it.
- SSE surface: `tool_call` events now carry `{ id, name, args, serverSlug, toolName }`. `tool_result` events carry `{ id, name, ok, result | error }`. Both ride the same `/api/chats/:id/messages/stream` SSE stream as the rest of the AI client. The chat UI renders them as cards identical in shape to the future `shell` tool's cards (decision §16) so a second tool slots in without a separate component.
- New runtime dependency: `@modelcontextprotocol/sdk` (^1). The SDK's `StdioClientTransport` and `Client` are wrapped in `src/mcp.js` so the rest of the server stays plain JSON-RPC and Node — no SDK leak into the public surface.
- New module: `src/mcp.js`. New REST surface: `GET /api/mcp/servers?projectDir=...`, `POST /api/mcp/servers (body: { projectDir, name, command, args?, env?, cwd? })`, `PATCH /api/mcp/servers/:id (body: { projectDir, ... })`, `DELETE /api/mcp/servers/:id?projectDir=...`, `POST /api/mcp/servers/:id/start (body: { projectDir })`, `POST /api/mcp/servers/:id/stop (body: { projectDir })`, `GET /api/mcp/servers/:id/tools?projectDir=...` (forces a re-discovery), `POST /api/mcp/call (body: { projectDir, serverId, toolName, args })` (used by the AI client; also exposed for tests). The AI client dispatches through the in-process `mcp` module; it does not round-trip through HTTP.

## 19. Prompt-size profiles — three system-prompt sizes, resolved per chat

- Three hand-written system prompts (`very-small | average | extensive`) live in [src/promptProfiles.js](../src/promptProfiles.js). They are static, not per-provider, and not generated from the discovered tool set; the goal is a small, predictable floor prompt that fits all five AI clients.
- `handleChatStream` prepends the resolved profile's system message at index 0 of `upstreamMessages`, **before** the chat's custom prompt (decision §15) and the transcript. The order is intentional: profile → custom prompt → transcript. The custom prompt's own text says "where they do not conflict with the active profile", so the layering is part of the contract.
- Resolution order: `chat.promptSize → settings.getResolved(projectDir).promptSize → app.promptSize → 'average'`. The chat wins because it is the most specific value the user actually picked. A missing or invalid value falls through to the next layer; the resolver never throws.
- Default is `average`. The same field is already plumbed through `src/chats.js`, `src/settings.js`, and the existing chat popover; this commit adds the actual prompt text, the resolver, the `GET /api/prompt-profiles` endpoint, and the chat-UI integration (server-driven picker + description line + friendly label in the meta line).
- New REST surface: `GET /api/prompt-profiles` → `{ default, profiles: [{ id, label, description, summary, systemMessage }, …] }`. Used by the chat popover so the picker is always in sync with what `handleChatStream` will use; the system messages are returned so a future "preview the active prompt" pane can show them.
- New module: `src/promptProfiles.js`. New test: [scripts/test-prompt-profiles.js](../scripts/test-prompt-profiles.js). No new runtime dependencies. The existing `prepublishOnly` lint chain in `package.json` was extended to `node -c src/promptProfiles.js`.


## 20. Live model catalog � per-provider /models, with a 1h cache

The chat <select> (decision �3) is populated from a live upstream
catalog rather than the project's hand-typed models array. Each
provider entry in ENDPOINTS carries a listModels(cred) that
returns a normalized [{ id, label, contextWindow? }]. The chat
UI calls it on first load and from a refresh button next to the
select; the response is cached on the server for 1 hour, keyed by
provider:credHash so a key rotation invalidates the entry.

- **Source per provider** (all in [src/ai.js](../src/ai.js)):
  - openai-compatible ? GET {baseUrl}/models (OpenAI-shaped, optional key)
  - nthropic ? curated catalog in ANTHROPIC_MODEL_CATALOG (no public list endpoint with API-key auth)
  - gemini ? GET /v1beta/models?pageSize=200, filtered to entries with generateContent in supportedGenerationMethods
  - ollama ? GET /api/tags, no auth
  - github-copilot ? curated catalog in COPILOT_MODEL_CATALOG (no public list endpoint)
  - openrouter ? GET /api/v1/models (OpenAI-shaped, optional key)
- **Endpoint**: GET /api/ai/models/live?provider=<id> ? { models, fetchedAt, cached }. The provider id is mandatory; unknown providers get 400. An upstream 4xx/5xx surfaces as 502 with { error, code: 'EUPSTREAM' }. The call is bounded by an 8 s AbortController timeout.
- **Merge rule**: the project's existing models array (from /api/ai/models) is unioned with the live list, deduped by id, sorted alphabetically. User-defined slugs always win on conflict so a hand-typed id is never shadowed by an upstream list.
- **New module surface**: i.listModels(provider, cred) is exported from [src/ai.js](../src/ai.js) so the AI client itself can ask for a list (e.g. for a future "verify this id exists" guard in streamChat). Throws ENO_LIST for providers without a list adapter, EUPSTREAM for upstream failures.
- **New tests**: [scripts/test-model-lists.js](../scripts/test-model-lists.js) (parsers, dedupe, credential handling, 13 fixtures per provider) and [scripts/test-model-lists-live.js](../scripts/test-model-lists-live.js) (HTTP smoke test against a running server: 400 on unknown provider, 200 + curated for Copilot, 502 EUPSTREAM for missing-key Gemini, cached:true on the second call). All offline; the live test only hits local 127.0.0.1:5732.

## 21. Native file tools - read_file / list_files / search_files / write_file

- `mouaif` ships four built-in file tools the model can call directly: `read_file`, `list_files`, `search_files`, `write_file`. They are the boring file primitives every coding agent needs (find a file, read it, edit it) and are wired through the same tool pipeline as `shell` and MCP (decisions §16, §18) - same tool-call / tool-result SSE shape, same authorization gate (§17), same UI cards.
- The four tools are off by default per project, toggled with a single `tools.file.enabled` boolean on the project file (parallel to `tools.shell.enabled`). The runtime authorization config (mode, allowlist, timeouts) lives under `tools.file` as well, so a project gets one block per native tool and the authorization module's `NATIVE_TOOLS = new Set(['shell', 'file'])` is the single source of truth for what counts as a native tool.
- Path safety: every model-supplied path is normalized to POSIX-relative, then resolved back through `realpath` (walking up to the first existing ancestor for `write_file` paths that don't exist yet). Anything that escapes the project root (`..`, absolute outside, symlink escape) returns `EOUTSIDE_PROJECT` - the same code the shell tool uses for the same condition.
- Caps (overridable per-app, in the app SQLite store): `fileReadMaxLines` (10000 lines, bypassed by `startLine` / `endLine` slices), `fileListMaxEntries` (1000), `fileSearchMaxMatches` (200), `fileSearchMaxBytes` (2 MB), `fileWriteMaxBytes` (1 MB). The defaults are deliberately tight so a model that asks for "every file in the repo" cannot blow the budget.
- Allowlist mode (`tools.file.mode = 'allowlist'`) matches the regex against `args.path` - the path the model is asking for - so a project that allows `^src/.*\.js$` will auto-approve `read_file('src/index.js')` but prompt for `read_file('package.json')`.
- New module: [src/tools/files.js](../src/tools/files.js). New tests: [scripts/test-file-tools.js](../scripts/test-file-tools.js) (68 assertions, covers every tool's happy path, every error code, and the cap overrides). Docs: [docs/features/file-tools.md](../features/file-tools.md).

## 22. Ask the user tool - let the model pause and ask structured questions

- `mouaif` ships a built-in `ask_user` tool the model can invoke to pause the chat and ask the user a structured question with **2-4 options**. The user always has a free-form "extra answer" textarea alongside their pick, so the response is never constrained to the offered options. The selection + extra text is returned to the model as a single `tool` message; the chat picks up where it left off.
- The tool is part of the base agent surface (decisions §16, §17, §21) and is always advertised to the model. Like `shell` and the file tools, it rides the standard tool-call / tool-result pipeline. Unlike `shell` / file tools, the authorization mode is **binary**: `{ off, ask }`. The model can't predict user answers, so an allowlist would be useless and an `allow` mode would defeat the purpose - the user must always be the source of truth. A legacy `allow` / `allowlist` value in the project file is clamped to `ask` by the authorization normalizer so a future migration can't bypass the prompt.
- The gate is the same `tools.<name>` block every native tool uses, surfaced in **Settings → Project settings → Tools** as a single `<select>` (`ask` / `off`). The mode auto-saves on change; there is no allowlist input.
- Validation runs before the gate so a bad question (too many options, duplicate `value`, missing label) returns an `EBADINPUT` `tool_result` directly to the model - the user is never asked to fix a model bug. The runner is a thin shim: it folds the user's structured answer (carried on `callOpts.answerPayload`, set by the gate when the `wait()` resolves) into the canonical `{ ok, content, result }` shape every other tool uses.
- The question + options ride a dedicated `ask_user_required` SSE event. The chat UI (`frontend/src/components/Chat.jsx`) listens for the event and renders a **the model is asking** card with the question, the options as 44 px-min tap targets, the always-on extra textarea, and **Send answer** / **Dismiss** actions. A nested `subagent` that calls `ask_user` routes the card into the subagent's live container (the `parentTool: 'subagent'` tag does the routing; no UI code change required to add a new wrapping tool).
- The decision is still recorded through the existing `/api/tools/authorization/decision` endpoint, extended to carry an optional structured `payload` (`{ choice, extra }`). The payload is generic - any future native tool can attach its own structured answer without a new endpoint. For every other tool the `payload` is undefined and the existing `allow-once` / `allow-session` / `allow-always` / `deny` semantics are unchanged.
- New module: [src/tools/ask.js](../src/tools/ask.js). New test: [scripts/test-ask-user.js](../scripts/test-ask-user.js) (40 assertions, covers the spec shape, validation rules, result-builder paths, the binary-mode gate, the `off` denial, the `ask` -> payload round trip via `recordDecision`, and the `getAuthorization` listing). Docs: [docs/features/ask-user-tool.md](../features/ask-user-tool.md).

## 23. Agents — subagent delegation personas

- An **agent** is a named persona (`{ name, content, tools? }`) stored in `.mouaif.json` under `agents` and used **exclusively as a delegation target for the `subagent` tool**. Agents are not chat personas — a chat-level persona is what custom prompts (§15) are for. Nothing in the chat stream, chat record, or project record references an agent.
- Three settings only: **name** (user-defined, unique per project, `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, mutable after creation — renaming auto-saves and redirects the edit UI to the new URL), **instructions** (the nested call's system message, 64 KiB cap), and an optional **tools** allowlist (unset = inherit the parent's full surface). Model, provider, and prompt size are never configurable on an agent — the nested call always uses the chat's.
- `subagent({ task, agent })` matches `agent` against stored names. The `agent` parameter description is built per request and enumerates the current names. An unknown name returns a typed `EUNKNOWN_AGENT` result listing the available names — no silent fallback to a generic subagent.
- Management UI lives only in **Settings → Project → Agents** (list + auto-saving editor + delete). No chat card, no picker, no project default.
- This supersedes the earlier file-based personas (`.agents/agents/*/AGENT.md`), the skills system (`.agents/skills/*/SKILL.md`, `selectedSkills`), the preset bundle layer (`src/agentPresets.js`), the `agentConfigs` map, and all chat/project agent-selection machinery (`chat.agentId`, `project.agentId`, the chat Agent card). Those were removed: chat selection duplicated custom prompts, and the extra fields were chat configuration, not persona.

## 24. Correction — the `e890096` preset conflation

- Commit `e890096` ("replace file-system agents with UI-defined presets") conflated *agents* and *presets* into a single settings blob and, in doing so, both dropped the delegation-target focus and bolted chat-configuration fields (`promptSize`, `modelId`, `providerId`, `agentFiles`) onto the persona. It also left §23 and the feature docs describing a file-based model the code no longer implemented.
- §23 (rewritten above) is the resolution: agents are JSON-defined subagent personas with exactly three settings; chat-level personas remain custom prompts. Docs (`docs/features/agents.md`) and code were updated in the same commit as this note.

## 25. MCP server scope — app-wide or per project

- §18 configured MCP servers **per project only**. This amendment adds a second scope: an MCP server entry now lives either in `<projectDir>/.mcp.json` under `servers` (**project** scope, unchanged) or in the app SQLite store under `mcp.servers` (**app** scope, new). The entry shape is identical in both scopes.
- **Merge rule** (matches §2's resolution order): a project sees the union — app entries first, then project entries — and a project entry whose slug matches an app entry **shadows** it for that project. The shadowed app entry still exists in the app store and stays editable; the project's Settings list shows scope badges so the layering is visible.
- **Scope is fixed at creation.** A `PATCH` carrying `scope` ignores it; moving a server is delete + re-add. Slug uniqueness stays scope-local so an app entry and a project entry may share a slug (that is exactly how shadowing happens).
- **Sessions are keyed by context**: the project dir when one is in scope, or the shared `'app'` context when a server is started without a project (the app-wide Settings list). A chat dispatches through its own context first, then `app`, so a server started from the app-wide list is reachable from every chat and each project still gets its own child when started from a chat.
- **REST**: `projectDir` becomes optional on the merged-view routes (`GET /api/mcp/servers`, `PATCH`, `DELETE`, `start`, `stop`, `tools`); without it the surface covers app-scoped servers only. `POST /api/mcp/servers` gains an explicit `scope` field (`'project'` default, requires `projectDir`; `'app'`). `/api/mcp/call` still requires `projectDir` (chat + authorization context). Server records now carry `scope: 'app' | 'project'`.
- **Authorization is unchanged**: the layered per-project gate (`.mcp.json` → app `mcp.authorization` fallback) already had an app-level layer for the shared gate; per-server and per-tool override maps remain project-scoped.
- **Settings UI**: the two scopes have two homes, one page each — **Settings → Application → MCP servers** (`#/settings/mcp`, app-wide list, no project needed, with a deep-link row into a project's list) and **Settings → Active project → MCP servers** (`#/settings/mcp?projectDir=…`, merged list with scope badges plus the per-server authorization rows). The add/edit form gains a scope segmented control (add only).
- Updated code: [src/mcp.js](../src/mcp.js) (scope-aware registry, `resolveMerged`, `findServerAnyScope`, context-keyed sessions), [src/index.js](../src/index.js) (`handleMcp`), [frontend/src/components/SettingsMcp.jsx](../frontend/src/components/SettingsMcp.jsx), [frontend/src/components/SettingsHome.jsx](../frontend/src/components/SettingsHome.jsx), [frontend/src/router.js](../frontend/src/router.js). New test: [scripts/test-mcp-scope.js](../scripts/test-mcp-scope.js) (27 assertions: app add, merged listing, slug shadowing, scope-routed update/remove, app-only listing). Docs: [docs/features/mcp.md](../features/mcp.md).
