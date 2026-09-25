# MCP — Model Context Protocol servers

## Overview

`mouaif` includes an **MCP client** that connects to any [Model Context Protocol](https://modelcontextprotocol.io/) server. MCP servers provide third-party integrations (such as databases, custom APIs, browser automation, or search) over stdio or HTTP transports. Once a server is configured, its tools are automatically made available to the AI assistant in your chat sessions.

## Usage

### Scope: global or per-project

Every MCP server can be configured in one of two scopes:

- **Global (App-wide)** — configured in **Settings → MCP**. Available across all registered projects and chats.
- **Project-scoped** — saved in your project's `.mcp.json` file so it can be committed and shared with team members.

A project sees the combination of both scopes, with project-level entries overriding global entries with the same name.

The two scopes can be managed from Settings:

- **Settings → App defaults → MCP servers** (`#/settings/mcp`) — the app-wide list, available in every project. No project is needed; Start/Stop work without one (the session lives in the shared `app` context and is reachable from every chat). A **Project servers** row at the bottom deep-links into a project's list by path. Tool-call permissions (the app-level gate) are deliberately *not* edited here — they live with the other tool checkboxes in **Settings → This project → Tools** and the chat tools card, so this page manages servers only and never shows a permission control that could be mistaken for a per-server toggle.
- **Settings → This project → MCP servers** (under **More settings**; `#/settings/mcp?projectDir=…`) — the single per-project entry point. It shows the merged server list (app entries first, each marked with an **app** / **project** badge, and **sorted alphabetically by name** within each scope group) with compact, edge-to-edge rows that match the Agents list: status and tool count, inline lifecycle actions, and a link to the server editor (`#/settings/mcp/<id>?projectDir=…`). Per-server and shared-gate authorization live in **Settings → This project → Tools** (the MCP rows of the tool tree) and the per-tool layer lives in the server editor; see Authorization below.

Each list row carries its lifecycle controls (**Start** / **Restart**, **Stop**, **↻** refresh on a ready server). There is no separate **Enabled** switch — the per-server authorization mode is the enable signal: `off` disables a server (never startable, tools hidden), anything else leaves it enabled (startable on demand). **Start** / **Restart** is available for any enabled server that isn't already starting or mid-action. Feedback for those actions is **inline on the row**: an in-flight action shows a neutral "starting…" / "refreshing…" line under the buttons, and a failure shows the typed error there with a next step ("tap the row to check the command/URL, then try again") — errors never land in a page-level status line away from the row that caused them. A server-side `errored` status renders the same slot with the typed code and a retry hint.

### Adding a server

1. Open the MCP servers page for the scope you want (the **+** button creates in that scope; the editor also shows an **App / This project** segmented control).
2. Tap **+** to add a server. Fill in:
   - **Scope** — *App (all projects)* or *This project*. Fixed at creation; delete and re-add to move a server.
   - **Name** — a short label (e.g. `filesystem`).
   - **Transport** — `Stdio` for a local child process, or `HTTP` for an MCP Streamable HTTP endpoint.
   - **Command** — stdio only; the executable to spawn (e.g. `node`).
   - **Arguments** — stdio only; tap **Add argument** for each argv entry (e.g. `path/to/server.js`, `--port`, and `8080` in three fields). Spaces, empty strings, quotes, and backslashes are preserved exactly. Do not wrap paths in shell quotes. **Remove** deletes that argument; a blank field deliberately sends an empty argument.
   - **Environment** — stdio only; one `KEY=value` per line. Denylisted keys (`LD_PRELOAD`, `NODE_OPTIONS`, ...) are stripped from the parent env first, then your overrides are applied on top.
   - **HTTP URL** — HTTP only; the Streamable HTTP endpoint (for example `https://example.com/mcp`).
   - **Authentication** — HTTP only; manual headers or [OAuth sign-in with PKCE](./mcp-oauth.md). OAuth supports automatic registration or a pre-registered public client ID; credentials stay in the OS keychain. Save, reopen the server, then sign in.
   - **HTTP headers** — HTTP only; one `Name: value` or `Name=value` per line. Values are write-only in the API and UI so bearer tokens are not echoed back. With OAuth enabled, a manual `Authorization` header is ignored.
   - **Working directory** — stdio only; optional, relative to the project. Resolved against the project root; anything outside the project is rejected with `EOUTSIDE_PROJECT`. For an app-wide server started without a project context, a relative cwd resolves against the `mouaif` process cwd.
3. Tap **Save**, then **Start** on the row to spawn the child and discover tools.

Configured servers are **enabled by default and start on demand** — there is no separate **Enabled** flag; the per-server authorization mode is the gate (`off` = disabled, anything else = enabled). Opening a chat no longer auto-starts a server. A server starts the first time the model calls one of its tools (transparent on-demand start), or when you tap Start/reload. Once running it advertises its tools until you Stop it or restart `mouaif`.

A project-scoped entry is committed to `<projectDir>/.mcp.json` under `servers`. Legacy `<projectDir>/.mouaif.json` `mcp.servers` entries are still read as a fallback until the editor saves MCP config. An app-scoped entry never touches a project file. The child process itself is in-memory only — it restarts on `mouaif` restart — and the discovered tool list is cached in the app SQLite store (`~/.mouaif/store.sqlite`, keyed by project directory + server id) so a stopped server still shows what it advertised the last time it ran, and the model keeps its tool surface in a new chat. Keeping the cache out of `.mcp.json` leaves the project file small and hand-editable; older builds that wrote an inline `toolCache` onto the entry are migrated into the store on first read and stripped from the file on the next write. Servers are stopped on `SIGINT`, `SIGTERM`, and `process.exit`.

### In a chat

When the model decides to call an MCP tool, the server intercepts the `tool_call` event, dispatches it to the matching server, and forwards the result back as a `tool_result` SSE event. The chat UI renders the call and the result as inline cards in the transcript:

- **Tool call card** — the composed tool name (`mcp__<serverSlug>__<toolName>`), a one-line argument summary, and a `running…` pill.
- **Tool result card** — the same name, the result body, and an `ok` / `error` pill. Long outputs are collapsed to the first ~7 lines; tap the card to expand.

The model sees the result as a structured `tool` message and can recover, retry, or summarize — same shape as any other tool the model invokes.

#### Per-chat tool picker

On a brand-new chat, the transcript carries a **Tools available to the model** card. Native tools (`shell`, `subagent`, the file tools) render as toggle chips; MCP tools render as a **nested checkbox list** — one parent row per configured MCP server, with an indented child row per discovered tool:

```
[ ] filesystem           (server)   ready · 4 tools   ▾
    [ ] mcp__filesystem__read_file
    [x] mcp__filesystem__list_files
    [ ] mcp__filesystem__search_files
    [ ] mcp__filesystem__write_file
[ ] playwright           (server)   stopped · 0 tools
    (no tools — start the server in Settings → MCP)
```

- The **parent checkbox** flips the whole server's tools in the per-chat `tools` filter at once (on/off), same as any native tool group — the server itself is always on, so this never gates the server, just which of its tools the model sees in this chat. The checkbox is checked when every discovered tool on that server is visible, unchecked when none are visible, and mixed when only some child tools are selected.
- Each server row has its own **collapse toggle** on the left. Folding it hides just that server's tool list — other servers stay open. The choice is per-MCP, not global, so the user can keep long lists collapsed without losing the rest of the surface. State is per-chat and resets when switching chats. **Every server starts collapsed** on a fresh chat — the picker doesn't expand the whole tool list by default. Only the chevron expands/collapses; only the checkbox changes the filter.
- Each **child checkbox** flips that single tool in the per-chat `tools` filter. The composed name (`mcp__<serverSlug>__<toolName>`) is the key the model sees in the tools array, so an unchecked row drops the tool from the next model turn and the parent checkbox updates in sync.
- Empty tool lists (server not yet started and no cache) render no children; the row shows a **↻ reload** control that starts the server on demand, and the children populate once it is running. The model's first call to that server also starts it transparently. The control shows its in-flight state (`is-busy`, `aria-busy`, disabled) across the tools card's own in-place rebuilds: the busy flag is mirrored on the hook as `state._mcpStartBusyServerId` and re-seeded into the freshly built group, because a flag stored only on the previous group object was discarded by the rebuild — the row repainted as idle, no spinner appeared, and the control stayed tappable mid-start.

The per-chat `tools` filter is the same field the native-tool chips use, so the picker is one consistent surface: the model sees exactly the tools the user has opted into, MCP or native, and the next turn honors the choice without a server round-trip.

### Authorization

Server **startup is not gated** — adding a server is the user's explicit "I trust this binary" decision. Every **tool call** is routed through the MCP authorization gate (default `ask`), which is layered — most specific first:

1. **Per tool** — an entry under the project's `authorization.tools.<composedName>` (e.g. `mcp__filesystem__write_file`) gates that one tool.
2. **Per server** — an entry under the project's `authorization.servers.<serverSlug>` gates every tool on that server.
3. **Project default** — the project's top-level `authorization` mode (in `.mcp.json`) gates every MCP call with no more specific override.
4. **App default** — the app store's `mcp.authorization` mode is the fallback for every project that has not set its own project default. This is what **Settings → App defaults → MCP servers** edits.

The app store has no server registry, so the app layer carries only the single shared gate (mode + allowlist); per-server and per-tool rules are project-scoped. The first layer with a `mode` wins; `ask` counts as a decision, so a per-server `ask` can tighten a project `allow`, and a project default can tighten the app default. Every layer accepts the same modes:

| Mode | Behavior |
|---|---|
| `off` | The covered specs are hidden from the model (no prompt tokens) — one tool, one server, or every `mcp__*` spec. Calls that still arrive return `ETOOL_DISABLED`. |
| `ask` | Every call must be approved by the user in the UI before the runner executes. |
| `allowlist` | Calls whose summary matches an allowlist regex run without prompting. The rest fall through to `ask`. Allowlist patterns are edited from the raw project file / app store — there is no dedicated textarea in the UI. |
| `allow` | Every covered call is auto-approved until the user flips the mode back. |

The Settings UI mirrors the layering everywhere the tool tree appears:

- **Chat tools card** — the transcript's Tools card shows one **Off / Ask / Allow** segment per configured MCP server. The segment shows the *effective* mode (the per-server override, or the gate when there is none); picking a mode writes `authorization.servers.<slug>`. Each server row's checkbox flips all its tools in the per-chat filter at once, and the leaves toggle single tools. The compact UI does not expose an override-reset button; clear an override by setting its `servers.<slug>` value to `null` in `.mcp.json`.
- **Settings → This project → Tools** — the same tree: each server row carries its Off/Ask/Allow override segment. The row description states whether the mode is an override or inherited (`override: ask` / `default (ask)`). Each server row's checkbox is that override's Off ↔ Ask shortcut. Auto-approve patterns set in the project file are still honored, but project-level allowlists have no textarea here anymore — edit them from the raw `.mcp.json` / `.mouaif.json`.
- **App-level gate** — the fallback mode (+ Auto-approve list) for every project without its own gate is persisted via `PUT /api/tools/authorization` with `{ scope: 'app', mcp: { mode?, allowlist? } }` and read with `GET /api/tools/authorization?scope=app`. It has no dedicated editor page; project permission rows live in **Settings → This project → Tools**.
- **Server editor** (`#/settings/mcp/<id>`) — the per-tool layer as an **Inherit / Off / Ask / Allow** select under **Discovered tools** (project-scoped servers only).

The rows write through `PUT /api/tools/authorization` with `{ projectDir, mcp: { mode?, servers?, tools? } }`; the app row writes `{ scope: 'app', mcp: { mode?, allowlist? } }`. A `null` value in a `servers` / `tools` map clears that override so the next layer up applies. `GET /api/tools/authorization?scope=app` reads the app-level gate on its own.

The authorization module ([docs/features/tool-authorization.md](./tool-authorization.md)) is the same gate every tool uses. The allowlist matches against the summary `"<composedName> <firstStringArg>"` (e.g. `mcp__filesystem__read_file src/index.js`), so a pattern can pin either the tool (`^mcp__fs__read_file$`) or the resource it touches (`^mcp__fs__read_file src/.*`). Choosing **Always allow** on an MCP prompt pins only that one tool to `mode: "allow"` under `authorization.tools` — it never flips the shared gate. Project rules are persisted in `.mcp.json` under `authorization` (written by `setAuthorization`), so they can be committed and reviewed alongside the server entries; the app default is persisted in the app SQLite store under `mcp.authorization` (written by `setAppMcpAuthorization`).

### Lifecycle

| Action | Trigger | Effect |
|---|---|---|
| **Start** | Tap Start/↻ on a row, or the first model tool-call against a stopped-but-enabled server | Spawn the child, run the MCP `initialize` handshake, run `tools/list`, cache the result in the app store. Status moves to `ready`. |
| **Stop** | Tap Stop, edit the server, or `mouaif` shuts down | Close the child. The cached tool list is kept so the surface stays visible. Status moves to `stopped`. |
| **Delete** | Tap Delete on a row | Close the child and clear the cached tool list with the entry. |
| **Refresh tools** | Tap Refresh on a ready server | Re-run `tools/list` without restarting the child; the cache is overwritten. Useful when the server's tool set changes at runtime. |
| **Restart** | Tap Start on a ready server | Stop, then re-start; a fresh `tools/list` runs and overwrites the cache. |
| **Errored** | Child crashes, JSON-RPC fails, or `initialize` times out | The session marks itself errored; the next call returns `EMCP_NOSESSION`. The Settings UI shows the typed error inline. |

A server that crashes mid-chat is treated as `ETOOL_DISABLED` for the rest of the chat and re-arms on next chat open (the user can tap Start to re-spawn).

## Behavior

- **Listings are sorted alphabetically by name.** `listServers` returns the merged view sorted case-insensitively by display name within the existing app-before-project scope grouping (scope wins, then name), so the Settings list is deterministic and easy to scan no matter what order servers were added in. The order is presentation-only — it does not change which entry shadows another or where a store write lands.
- **Server entries are scoped — app or project.** Project entries live in `<projectDir>/.mcp.json` under `servers`, so they can be committed to the repo and reviewed by collaborators. App entries live in the app SQLite store under `mcp.servers` and are visible to every project. A project entry shadows an app entry with the same slug; the app entry stays editable from the app-wide list. Legacy `.mouaif.json` `mcp.servers` is read as a fallback. Runtime sessions are keyed by context (project dir, or the shared `app` context for project-less starts), so a chat dispatches to its own child and a server started from the app-wide list is reachable from every chat.
- **Tool names are namespaced.** The model sees `mcp__<serverSlug>__<toolName>` (the standard MCP convention). Built-in tools (`shell`, future) use their own prefixes. The AI client routes `mcp__…` names through `mcp.callTool` and leaves the rest alone.
- **Discovery is cached on the session *and* persisted in the app store.** A successful `tools/list` lands on the server record's in-memory session and is also written to the app SQLite store (`mcp_tool_cache` table, keyed by project directory + server id). The AI client uses the live session when the server is running; it falls back to the persisted cache when the server is stopped (e.g. after a mouaif restart, or before the model first calls it). The cache is runtime state, not config, which is why it does not live in the project file; legacy inline `toolCache` entries are migrated into the store on first read.
- **Servers start on demand, never on chat open.** `GET /api/tools/list` is a pure status report — `ensureServersRunning` never spawns a server. Opening a chat therefore never cold-starts a configured MCP server. A server starts the first time the model calls one of its tools (`callTool` does the transparent start within the same awaited call) or when the user taps the reload/Start control. A stopped-but-enabled server still exposes its persisted tool surface (so the model can call it and trigger the start); a disabled (`off`) server is surfaced as such and is never started.
- **Tool calls ride the same SSE stream as the rest of the chat.** `tool_call` and `tool_result` are first-class events of the [AI client](./ai-client.md). The chat UI renders them inline; the [trace file](./trace.md) writes them as `tool_call` / `tool_result` lines.
- **Errors are typed.** Transport failures become `EMCP_TRANSPORT`; JSON-RPC errors become `EMCP_RPC`; timeouts become `EMCP_TIMEOUT`; missing slugs become `EMCP_NOSESSION`; missing tools become `EMCP_NOTFOUND`. The chat UI can branch on `code` without parsing the message.
- **HTTP MCP uses Streamable HTTP.** Set `transport: "http"` and `url` to a Streamable HTTP MCP endpoint. Optional headers are sent with every transport request and are redacted in API responses.
- **Server args are not shell-parsed.** The editor holds `args` as a string array from load through save, with one input per entry. No splitting, trimming, expansion, or quoting is applied, so editing a server preserves every argv value, including empty strings and multi-word paths.
- **Env denylist is enforced.** `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `NODE_DEBUG`, and a few related vars are stripped from the inherited env before the per-server env map is applied. The denylist does not strip keys the user explicitly set in the per-server env — the user can opt in to those if they want.
- **Server cwd must be inside the project.** Anything outside the project root is rejected with `EOUTSIDE_PROJECT`. The same rule the [shell tool](./shell-tool.md) uses.
- **Project output paths work across MCP servers.** Mouaif answers MCP `roots/list` with the active project's canonical filesystem path. Before dispatching any MCP tool, standard project-relative output arguments (`filePath`, `outputPath`, `outputDirPath`, `requestFilePath`, and `responseFilePath`) are converted to canonical absolute paths and rejected if they escape the project. Projects opened through a symlink accept both that symlink spelling and the real on-disk spelling. App-wide server configuration is shared, but each project gets its own runtime session and root so an app-settings session cannot incorrectly mark a valid project artifact as out of scope. This is independent of the server or tool name and lets tools save artifacts directly for models without image input support.
- **Image results are forwarded to the model — both block shapes.** MCP tools can return an image two ways: a top-level `image` content block (`{ type:"image", data, mimeType }`) or an embedded `resource` block (`{ type:"resource", resource:{ blob, mimeType:"image/*" } }`). Screenshot, chart, and diagram servers commonly use the resource shape. Mouaif extracts both into an `image_url` part appended to the follow-up turn, so image-capable models actually see the bytes instead of them being dropped. The chat UI renders both inline too, as a 220 px thumbnail. Tap it to open the image full screen in the same viewer `read_file` images use (close button, Escape, or a tap outside the picture). Non-image resource blocks still show as a JSON stub. (`webpreview` is the one exception — its screenshot is shown to the user only, never fed to the model.)
- **No new SSE events for the AI client itself.** Tool dispatch reuses the existing `tool_call` / `tool_result` events; the AI client's parse path accumulates OpenAI-compatible `tool_call` deltas by index and flushes them when the upstream signals `finish_reason: tool_calls`.
- **Server child is tracked in-memory only.** A `process.exit` reaps the child; a crash surfaces as `errored` status with the typed code in the inline error.

## Related

- [docs/features/ai-client.md](./ai-client.md) — `tool_call` and `tool_result` SSE events, the parse path that accumulates OpenAI-compatible deltas.
- [docs/features/tool-authorization.md](./tool-authorization.md) — the gate every tool call passes through.
- [docs/features/trace.md](./trace.md) — `tool_call` and `tool_result` lines on the NDJSON trace.
- [docs/features/mcp-error-modal.md](./mcp-error-modal.md) — the Settings modal for typed MCP server lifecycle failures.
