# mouaif — Architectural decisions

Resolved by `Ask questions for what's missin` on 2026-07-13. These choices are now binding for every subsequent `feat:` commit. Any change requires a new ADR-style note in this file and, if a commit has already shipped, a `refactor!:` or `fix:` commit that updates the relevant code and doc.

## 1. Settings storage — SQLite via `better-sqlite3`

- App-level settings live in `~/.mouaif/store.sqlite` (managed by `better-sqlite3`).
- Project-level settings still live in `<projectDir>/.mouaif.json` so they can be committed to a repo and edited by hand.
- New runtime dependency: `better-sqlite3` (^11). Add it in the settings commit.

## 2. Settings scope — project overrides app

- Resolution order: defaults → app → project. Project wins on conflict.
- Documented in `docs/features/app-and-project-settings.md`.

## 3. Providers and models — separate scopes, no pre-made model list

- A provider connection is `{ id, baseUrl, apiKey, auth, oauthAccount? }` and is persisted in the app SQLite store. It owns transport and credentials.
- A model is `{ id: slug, provider, label?, contextWindow?, ... }` and is defined in project settings. `provider` references an app-level provider connection.
- Provider credentials are never written to project files. At request time, the server hydrates the selected project model with its matching app-level provider connection.
- There is no built-in model list. Model IDs remain entirely user-defined per project.

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
- After that: virtual list primitive → models → folder picker → **AI client core (4 providers + Copilot, key-only, server proxy, SSE — covers OpenAI via the `openai-compatible` provider with an API token, plus Anthropic, Gemini, Ollama, and GitHub Copilot reserved) → auth (@napi-rs/keyring + per-model auth + loopback callback skeleton) → Anthropic OAuth → trace → project card → custom prompts → grouped chat list → prompt-size profiles → tabbed mobile UI shell → custom DevTools-style inspector → OpenRouter provider (apikey-only, OpenAI-shaped, shares the `openai` keyring namespace with the openai-compatible family)**.

## 10. AI client — server-side proxy with SSE streaming

- The mobile UI never holds an API key. All provider calls go through `POST /api/ai/chat` on the mouaif server, which streams the response back over SSE.
- Provider set, this commit: `openai-compatible`, `anthropic`, `gemini`, `ollama`, `github-copilot`. The first four are key-only in this commit; `github-copilot` is documented but its auth lands with the OAuth commits. `openrouter` is the sixth provider — OpenAI-shaped, apikey-only, reuses the openai-compatible builder and parser, and stores its key in the `openai` keyring namespace so users do not have to manage a separate credential store.
- The request-time model is the merge of the project model `{ id, provider, label?, contextWindow? }` and its app-level provider connection `{ baseUrl, apiKey, auth, oauthAccount? }`. Legacy self-contained model records remain readable during migration.
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
- The scan endpoint is a one-pass directory walk honoring the same home-allowlist rules as the folder picker (decision §4). Binary files are filtered by extension; the default extension allowlist is text-friendly (`.js .jsx .ts .tsx .mjs .cjs .json .md .txt .py .rb .go .rs .java .kt .swift .c .h .cpp .hpp .css .html .yml .yaml .toml .sh`).
- New module: `src/tags.js`. New REST surface: `GET/PUT /api/projects/<id>/tags`, `POST /api/projects/<id>/tags/scan`, `DELETE /api/projects/<id>/tags/files/*`. The injection happens in `src/index.js → handleChatStream` immediately before the existing `promptId` block.

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
- A server is configured **at the project level** in `.mouaif.json` under a new `mcp.servers` array. Each entry is `{ id, name, command, args?, env?, cwd?, enabled, source }` where `command` is the executable to spawn, `args` is the arg list, and `env` is a per-server env-var map merged on top of the parent env (decision §16 denylist still applies). The server is **off by default** per project (matching the shell tool's policy); a project's enabled server list is what the AI client actually starts.
- Server lifecycle: `mcp.start(projectDir, serverId)` spawns the child process, opens a stdio JSON-RPC session, sends `initialize`, and discovers the server's tool list. The discovery result is cached on the server record so repeated chats don't re-spawn. `mcp.stop(projectDir, serverId)` kills the child and clears the cache. Servers are stopped on `process.exit`. Tools are advertised to the model as `{ name: 'mcp__<serverSlug>__<toolName>', description, parameters }` (the double-underscore is the standard MCP convention so model output stays unambiguous).
- Tool dispatch: when the upstream emits a `tool_call` whose `name` matches `mcp__<serverSlug>__<toolName>`, the AI client calls `mcp.callTool(projectDir, serverSlug, toolName, args)`, which writes a `tools/call` JSON-RPC request over the server's stdio and reads the response. The result is wrapped as `{ ok, content: [...], isError? }` and forwarded as a `tool` message. Errors from the server (JSON-RPC error codes, transport failures, server crashes) become typed `EMCP_TRANSPORT`, `EMCP_RPC`, or `ETIMEDOUT` results — the model sees a structured `tool_result` and can recover.
- Authorization: a per-project `mcp.authorize` toggle (default `ask`, same enum as decision §17) gates every MCP tool call. The existing authorization module is reused; the tool name is `<serverSlug>/<toolName>` and the allowlist matches against `arg` summaries (the first string arg, typically the resource path). Server startup is **not** gated — it is the user's explicit "I added this server" decision that authorizes the lifecycle. A crash in the server process is treated as `ETOOL_DISABLED` for the rest of the chat and re-armed on next chat open.
- Persistence: server entries live in `<projectDir>/.mouaif.json` (so they can be committed with the project) but the actual child process and tool cache are in-memory only — they restart on server boot. The Settings UI lists the configured servers with their live status (stopped / starting / ready / errored), lets the user add / remove / enable / disable, and surfaces the discovered tool list on tap.
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

