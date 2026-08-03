# MCP — Model Context Protocol servers

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

`mouaif` ships an **MCP client** that talks to any [Model Context Protocol](https://modelcontextprotocol.io/) server the user configures. MCP servers are the third-party tool ecosystem — Filesystem, Git, Postgres, Playwright, custom internal tools — they speak JSON-RPC over stdio or Streamable HTTP and advertise their tools. Once a server is configured for a project, the AI client surfaces its `tools/list` as part of the model's tool set, intercepts `tool_call` events, dispatches them to the running MCP server, and feeds the result back as a `tool` message.

The server itself stays plain Node. The `@modelcontextprotocol/sdk` is scoped to a single module ([src/mcp.js](../../src/mcp.js)) so MCP transport handling stays localized.

## Usage

### Scope: app-wide or per project

Every MCP server is configured in exactly one of two scopes:

- **App** — stored in the app SQLite store (`~/.mouaif/store.sqlite`) under `mcp.servers`. The server is visible to every project: its tools are advertised in any chat, and its child process runs per context (each project gets its own spawn).
- **Project** — committed to `<projectDir>/.mcp.json` under `servers`, so it can be reviewed and shared with the repo.

A project sees the **union** of both scopes; a project entry whose slug matches an app entry shadows it (the settings resolution order, decisions §2). The shadowed app entry still exists in the app store — the app-wide MCP settings list can edit, start, or delete it — but the chat in that project only sees the project entry.

The two scopes have two homes in Settings, each its own page (no tabs):

- **Settings → App defaults → MCP servers** (`#/settings/mcp`) — the app-wide list, available in every project. No project is needed; Start/Stop work without one (the session lives in the shared `app` context and is reachable from every chat). It also carries the single **Default permission** row (the app-level gate). A **Project servers** row at the bottom deep-links into a project's list by path.
- **Settings → This project → MCP servers** (under **More settings**; `#/settings/mcp?projectDir=…`) — the single per-project entry point. It shows the merged server list (app entries first, each marked with an **app** / **project** badge) with compact, edge-to-edge rows that match the Agents list: status and tool count, inline lifecycle actions, and a link to the server editor (`#/settings/mcp/<id>?projectDir=…`). Per-server and shared-gate authorization live in **Settings → This project → Tools** (the MCP rows of the tool tree) and the per-tool layer lives in the server editor; see Authorization below.

### Adding a server

1. Open the MCP servers page for the scope you want (the **+** button creates in that scope; the editor also shows an **App / This project** segmented control).
2. Tap **+** to add a server. Fill in:
   - **Scope** — *App (all projects)* or *This project*. Fixed at creation; delete and re-add to move a server.
   - **Name** — a short label (e.g. `filesystem`).
   - **Transport** — `Stdio` for a local child process, or `HTTP` for an MCP Streamable HTTP endpoint.
   - **Command** — stdio only; the executable to spawn (e.g. `node`).
   - **Arguments** — stdio only; whitespace-separated arg list (e.g. `path/to/server.js --port 8080`).
   - **Environment** — stdio only; one `KEY=value` per line. Denylisted keys (`LD_PRELOAD`, `NODE_OPTIONS`, ...) are stripped from the parent env first, then your overrides are applied on top.
   - **HTTP URL** — HTTP only; the Streamable HTTP endpoint (for example `https://example.com/mcp`).
   - **HTTP headers** — HTTP only; one `Name: value` or `Name=value` per line. Values are write-only in the API and UI so bearer tokens are not echoed back.
   - **Working directory** — stdio only; optional, relative to the project. Resolved against the project root; anything outside the project is rejected with `EOUTSIDE_PROJECT`. For an app-wide server started without a project context, a relative cwd resolves against the `mouaif` process cwd.
   - **Enabled** — on by default. Disabled servers do not start and are not advertised to the model.
3. Tap **Save**, then **Start** on the row to spawn the child and discover tools.

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

- The **parent checkbox** enables or disables the whole server (PATCHes the project config via `/api/mcp/servers/:id`; flips the running session). Disabling the server greys out the child rows.
- Each server row has its own **collapse toggle** on the right (`▾` / `▸`). Folding it hides just that server's tool list — other servers stay open. The choice is per-MCP, not global, so the user can keep long lists collapsed without losing the rest of the surface. State is per-chat and resets when switching chats. **Every server starts collapsed** on a fresh chat — the picker doesn't expand the whole tool list by default — and the user opens a server by tapping the row or the toggle. Clicking the checkbox itself still toggles the server enable; only the checkbox changes the enable, everything else on the row is a collapse handle.
- Each **child checkbox** flips that single tool in the per-chat `tools` filter. The composed name (`mcp__<serverSlug>__<toolName>`) is the key the model sees in the tools array, so an unchecked row drops the tool from the next model turn and the chip above flips in sync.
- A checked child is a no-op when the server itself is disabled — the model never sees tools from a stopped server, so the child row mirrors the parent state to keep the surface honest.
- Empty tool lists (server not yet started) render no children; the user starts the server from **Settings → MCP** and the children populate on the next chat open.

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
| `allowlist` | Calls whose summary matches an allowlist regex run without prompting. The rest fall through to `ask`. In the UI this is the **Auto-approve list** disclosure under **Ask** on the app-level MCP page; project-level patterns are edited from the raw project file. |
| `allow` | Every covered call is auto-approved until the user flips the mode back. |

The Settings UI mirrors the layering everywhere the tool tree appears:

- **Chat tools card** — the transcript's Tools card shows an **MCP default** row (the project's shared gate) plus one **Off / Ask / Allow** segment per configured MCP server. The segment shows the *effective* mode (the per-server override, or the gate when there is none); picking a mode writes `authorization.servers.<slug>`, and a ↺ reset appears only when an override is set, clearing it back to the gate. Server rows keep their enable checkbox (server on/off) and their per-chat tool-filter leaves.
- **Settings → This project → Tools** — the same tree: the **MCP default** row carries the project gate, and each server row carries its Off/Ask/Allow override segment (with the same ↺ reset). The row description states whether the mode is an override or inherited (`override: ask` / `default (ask)`). Auto-approve patterns set in the project file are still honored, but project-level allowlists have no textarea here anymore — edit them from the raw `.mcp.json` / `.mouaif.json`.
- **Settings → App defaults → MCP servers** (`#/settings/mcp`) — a single **Default permission** row edits the app-level gate (mode + Auto-approve list), the fallback for every project without its own gate.
- **Server editor** (`#/settings/mcp/<id>`) — the per-tool layer as an **Inherit / Off / Ask / Allow** select under **Discovered tools** (project-scoped servers only).

The rows write through `PUT /api/tools/authorization` with `{ projectDir, mcp: { mode?, servers?, tools? } }`; the app row writes `{ scope: 'app', mcp: { mode?, allowlist? } }`. A `null` value in a `servers` / `tools` map clears that override so the next layer up applies. `GET /api/tools/authorization?scope=app` reads the app-level gate on its own.

The authorization module ([docs/features/tool-authorization.md](./tool-authorization.md)) is the same gate every tool uses. The allowlist matches against the summary `"<composedName> <firstStringArg>"` (e.g. `mcp__filesystem__read_file src/index.js`), so a pattern can pin either the tool (`^mcp__fs__read_file$`) or the resource it touches (`^mcp__fs__read_file src/.*`). Choosing **Always allow** on an MCP prompt pins only that one tool to `mode: "allow"` under `authorization.tools` — it never flips the shared gate. Project rules are persisted in `.mcp.json` under `authorization` (written by `setAuthorization`), so they can be committed and reviewed alongside the server entries; the app default is persisted in the app SQLite store under `mcp.authorization` (written by `setAppMcpAuthorization`).

### Lifecycle

| Action | Trigger | Effect |
|---|---|---|
| **Start** | Tap Start on a row, or open a chat that references a stopped server | Spawn the child, run the MCP `initialize` handshake, run `tools/list`, cache the result in the app store. Status moves to `ready`. |
| **Stop** | Tap Stop, edit the server, or `mouaif` shuts down | Close the child. The cached tool list is kept so the surface stays visible. Status moves to `stopped`. |
| **Delete** | Tap Delete on a row | Close the child and clear the cached tool list with the entry. |
| **Refresh tools** | Tap Refresh on a ready server | Re-run `tools/list` without restarting the child; the cache is overwritten. Useful when the server's tool set changes at runtime. |
| **Restart** | Tap Start on a ready server | Stop, then re-start; a fresh `tools/list` runs and overwrites the cache. |
| **Errored** | Child crashes, JSON-RPC fails, or `initialize` times out | The session marks itself errored; the next call returns `EMCP_NOSESSION`. The Settings UI shows the typed error inline. |

A server that crashes mid-chat is treated as `ETOOL_DISABLED` for the rest of the chat and re-arms on next chat open (the user can tap Start to re-spawn).

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| `GET`    | `/api/mcp/servers?projectDir=<abs>` | `projectDir` optional — without it only app-scoped servers; with it the merged app + project view | `{ servers: [{ id, name, slug, transport, command, url, args, env, headers, cwd, enabled, scope, status, tools? }] }` |
| `POST`   | `/api/mcp/servers` | `{ projectDir?, scope?, transport?, name, command?, url?, headers?, args?, env?, cwd?, enabled? }` — `transport` is `'stdio'` (default) or `'http'`; `scope` is `'project'` (default, requires `projectDir`) or `'app'` | `{ server }` (201) |
| `PATCH`  | `/api/mcp/servers/:id` | `{ projectDir?, transport?, name?, command?, url?, headers?, args?, env?, cwd?, enabled? }` — `scope` is fixed at creation and ignored in patches | `{ server }` (stops running session) |
| `DELETE` | `/api/mcp/servers/:id?projectDir=<abs>` | `projectDir` optional | `{ ok, removed }` (stops running session) |
| `POST`   | `/api/mcp/servers/:id/start` | `{ projectDir? }` | `{ server }` (status reflects the new state) |
| `POST`   | `/api/mcp/servers/:id/stop` | `{ projectDir? }` | `{ ok }` |
| `GET`    | `/api/mcp/servers/:id/tools?projectDir=<abs>` | `projectDir` optional | `{ tools: [{ name, description, inputSchema }] }` (forces a re-discovery) |
| `POST`   | `/api/mcp/call` | `{ projectDir, serverId, toolName, args }` | `{ ok, content: [...], isError? }` |

Every server record carries `scope: 'app' | 'project'` so the UI can badge rows and route edits to the right file. `/api/mcp/call` still requires `projectDir` — it runs through the project's chat + authorization context.

The AI client dispatches through the in-process `mcp` module; it does not round-trip through HTTP. The REST endpoints are for the Settings UI and for tests.

### Programmatic (Node)

```js
const mcp = require('mouaif/src/mcp.js');

// Add a server.
const server = mcp.addServer(projectDir, {
  name: 'filesystem',
  command: 'node',
  args: ['./servers/filesystem.js', projectDir]
});

// Start it (async: spawns, handshakes, discovers).
const ready = await mcp.startServer(projectDir, server.id);
console.log(ready.tools); // [{ name, description, inputSchema }, ...]

// Call a tool.
const out = await mcp.callTool(projectDir, ready.slug, 'read_file', { path: 'README.md' });
console.log(out.content); // [{ type: 'text', text: '...' }]

// Tear down.
await mcp.stopServer(projectDir, server.id);
```

## Behavior

- **Server entries are scoped — app or project.** Project entries live in `<projectDir>/.mcp.json` under `servers`, so they can be committed to the repo and reviewed by collaborators. App entries live in the app SQLite store under `mcp.servers` and are visible to every project. A project entry shadows an app entry with the same slug; the app entry stays editable from the app-wide list. Legacy `.mouaif.json` `mcp.servers` is read as a fallback. Runtime sessions are keyed by context (project dir, or the shared `app` context for project-less starts), so a chat dispatches to its own child and a server started from the app-wide list is reachable from every chat.
- **Tool names are namespaced.** The model sees `mcp__<serverSlug>__<toolName>` (the standard MCP convention). Built-in tools (`shell`, future) use their own prefixes. The AI client routes `mcp__…` names through `mcp.callTool` and leaves the rest alone.
- **Discovery is cached on the session *and* persisted in the app store.** A successful `tools/list` lands on the server record's in-memory session and is also written to the app SQLite store (`mcp_tool_cache` table, keyed by project directory + server id). The AI client uses the live session when the server is running; it falls back to the persisted cache when the server is enabled but stopped (e.g. after a mouaif restart, or on a new chat before the auto-start fires). A tool call against a stopped server returns `EMCP_NOSESSION` — the honest signal — but the model still sees the surface and the user can tap Start. The cache is runtime state, not config, which is why it does not live in the project file; legacy inline `toolCache` entries are migrated into the store on first read.
- **Enabled servers auto-start on chat open.** `GET /api/tools/list` (which the chat UI calls on load) awaits `ensureEnabledServers(projectDir)`: every enabled server that is not already `ready` / `starting` is spawned and re-discovered before the first catalog is returned, including servers loaded directly from `.mcp.json` with no existing cache. Disabled servers stay stopped. A failed start is captured as `errored` on that server only — the rest of the enabled set still starts and native tools are still returned.
- **Tool calls ride the same SSE stream as the rest of the chat.** `tool_call` and `tool_result` are first-class events (decision §10). The chat UI renders them inline; the trace file (decision §5) writes them as `tool_call` / `tool_result` lines.
- **Errors are typed.** Transport failures become `EMCP_TRANSPORT`; JSON-RPC errors become `EMCP_RPC`; timeouts become `EMCP_TIMEOUT`; missing slugs become `EMCP_NOSESSION`; missing tools become `EMCP_NOTFOUND`; disabled servers become `EMCP_DISABLED`. The chat UI can branch on `code` without parsing the message.
- **HTTP MCP uses Streamable HTTP.** Set `transport: "http"` and `url` to a Streamable HTTP MCP endpoint. Optional headers are sent with every transport request and are redacted in API responses.
- **Server args are not shell-parsed.** The `args` field is a whitespace-separated token list. Quoted multi-word args are not yet supported; a future revision can add a real `shlex`-style splitter.
- **Env denylist is enforced.** `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `NODE_DEBUG`, and a few related vars are stripped from the inherited env before the per-server env map is applied. The denylist does not strip keys the user explicitly set in the per-server env — the user can opt in to those if they want.
- **Server cwd must be inside the project.** Anything outside the project root is rejected with `EOUTSIDE_PROJECT`. The same rule decision §16 uses for `shell`.
- **Project output paths work across MCP servers.** Mouaif answers MCP `roots/list` with the active project. Before dispatching any MCP tool, standard project-relative output arguments (`filePath`, `outputPath`, `outputDirPath`, `requestFilePath`, and `responseFilePath`) are converted to absolute paths and rejected if they escape the project. This is independent of the server or tool name and lets tools save artifacts directly for models without image input support.
- **No new SSE events for the AI client itself.** Tool dispatch reuses the existing `tool_call` / `tool_result` events; the AI client's parse path accumulates OpenAI-compatible `tool_call` deltas by index and flushes them when the upstream signals `finish_reason: tool_calls`.
- **Server child is tracked in-memory only.** A `process.exit` reaps the child; a crash surfaces as `errored` status with the typed code in the inline error.

## Implementation notes

- Source: [src/mcp.js](../../src/mcp.js). Public surface: `listServers`, `getServer`, `addServer`, `updateServer`, `removeServer`, `startServer`, `stopServer`, `stopAll`, `listDiscoveredTools`, `callTool`, `composedToolNameFor`, `listComposedToolSpecs`, `resolveMerged`. The merged app + project view comes from `resolveMerged(projectDir)`; scope-aware writes route through `findServerAnyScope` so a shadowed app entry stays editable. `startServer()` picks `StdioClientTransport` or `StreamableHTTPClientTransport` from the SDK based on `entry.transport`.
- Server wiring: [src/ai.js](../../src/ai.js) → `streamChat()`. After the upstream finishes streaming, accumulated `tool_call` deltas are dispatched through `mcp.callTool()`. Tool results are surfaced as `tool_result` SSE events, not fed back into the same stream.
- HTTP wiring: [src/index.js](../../src/index.js) → `handleMcp()`. The Settings UI hits the REST surface; the AI client never goes through HTTP.
- SDK isolation: the `@modelcontextprotocol/sdk` is loaded lazily in `getSdk()`. A failure to load the SDK (e.g. a fresh checkout with no `node_modules`) surfaces as `EMODULE` on every server action — the rest of the server boots cleanly without MCP.
- Frontend: [src/web/src/components/SettingsMcp.jsx](../../src/web/src/components/SettingsMcp.jsx) (list + editor views) and the home card on [src/web/src/components/SettingsHome.jsx](../../src/web/src/components/SettingsHome.jsx). Tool cards in the chat live in [src/web/src/components/Chat.jsx](../../src/web/src/components/Chat.jsx) → `appendToolCallCard` / `appendToolResultCard`.
- Lifecycle hookup: `mcp.installShutdown()` registers `process.once('exit' | 'SIGINT' | 'SIGTERM', ...)` to stop every running server child cleanly. Called from [src/index.js](../../src/index.js) at require time.

## Related

- [docs/features/ai-client.md](./ai-client.md) — `tool_call` and `tool_result` SSE events, the parse path that accumulates OpenAI-compatible deltas.
- [docs/features/tool-authorization.md](./tool-authorization.md) — the gate every tool call passes through.
- [docs/features/trace.md](./trace.md) — `tool_call` and `tool_result` lines on the NDJSON trace (decision §5).
- Decision: [docs/decisions.md §18](../decisions.md) (this feature) and §10 (AI client wire format), §16 (the shell tool that established the tool model).
