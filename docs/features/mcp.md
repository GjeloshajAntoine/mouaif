# MCP — Model Context Protocol servers

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

`mouaif` ships an **MCP client** that talks to any [Model Context Protocol](https://modelcontextprotocol.io/) server the user configures. MCP servers are the third-party tool ecosystem — Filesystem, Git, Postgres, Playwright, custom internal tools — they speak a single JSON-RPC-over-stdio protocol and advertise their tools. Once a server is configured for a project, the AI client surfaces its `tools/list` as part of the model's tool set, intercepts `tool_call` events, dispatches them to the running MCP server, and feeds the result back as a `tool` message.

The server itself stays plain Node. The `@modelcontextprotocol/sdk` is scoped to a single module ([src/mcp.js](../../src/mcp.js)) so adding the next transport (HTTP, WebSocket) is a localized change.

## Usage

### Adding a server

1. Open a chat in the project you want to configure (or visit **Settings → Project overrides** and load a project directory).
2. From **Settings → Project features → MCP servers**, the project is already in scope — no path to type.
3. Tap **+** to add a server. Fill in:
   - **Name** — a short label (e.g. `filesystem`).
   - **Command** — the executable to spawn (e.g. `node`).
   - **Arguments** — whitespace-separated arg list (e.g. `path/to/server.js --port 8080`).
   - **Environment** — one `KEY=value` per line. Denylisted keys (`LD_PRELOAD`, `NODE_OPTIONS`, ...) are stripped from the parent env first, then your overrides are applied on top.
   - **Working directory** — optional, relative to the project. Resolved against the project root; anything outside the project is rejected with `EOUTSIDE_PROJECT`.
   - **Enabled** — on by default. Disabled servers do not start and are not advertised to the model.
4. Tap **Save**, then **Start** on the row to spawn the child and discover tools.

The server entry is committed to `<projectDir>/.mcp.json` under `servers`. Legacy `<projectDir>/.mouaif.json` `mcp.servers` entries are still read as a fallback until the editor saves MCP config. The child process itself is in-memory only — it restarts on `mouaif` restart — and the discovered tool list is cached in the app SQLite store (`~/.mouaif/store.sqlite`, keyed by project directory + server id) so a stopped server still shows what it advertised the last time it ran, and the model keeps its tool surface in a new chat. Keeping the cache out of `.mcp.json` leaves the project file small and hand-editable; older builds that wrote an inline `toolCache` onto the entry are migrated into the store on first read and stripped from the file on the next write. Servers are stopped on `SIGINT`, `SIGTERM`, and `process.exit`.

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

Server **startup is not gated** — adding a server is the user's explicit "I trust this binary" decision. Every **tool call**, however, is routed through the project's shared MCP authorization mode (default `ask`), set from the **MCP tools** segmented control at the top of **Settings → MCP**:

| Mode | Behavior |
|---|---|
| `off` | Every `mcp__*` tool is hidden from the model (no prompt tokens). Calls that still arrive return `ETOOL_DISABLED`. |
| `ask` | Every call must be approved by the user in the UI before the runner executes. |
| `allowlist` | Calls whose first string arg matches an allowlist regex run without prompting. The rest fall through to `ask`. In the UI this is the **Auto-approve list** disclosure under **Ask**. |
| `allow` | Every call in the session is auto-approved until the chat is reopened or the user flips back to `ask`. |

The authorization module ([docs/features/tool-authorization.md](./tool-authorization.md)) is the same gate every tool uses; the tool name is `mcp__<serverSlug>__<toolName>` and the allowlist matches against the first string arg (typically the resource path the user is asking the model to act on). The mode is persisted in `.mcp.json` under `authorization` (written by `setAuthorization`), so it can be committed and reviewed alongside the server entries.

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
| `GET`    | `/api/mcp/servers?projectDir=<abs>` | — | `{ servers: [{ id, name, slug, command, args, env, cwd, enabled, status, tools? }] }` |
| `POST`   | `/api/mcp/servers` | `{ projectDir, name, command, args?, env?, cwd?, enabled? }` | `{ server }` (201) |
| `PATCH`  | `/api/mcp/servers/:id` | `{ projectDir, name?, command?, args?, env?, cwd?, enabled? }` | `{ server }` (stops running session) |
| `DELETE` | `/api/mcp/servers/:id?projectDir=<abs>` | — | `{ ok, removed }` (stops running session) |
| `POST`   | `/api/mcp/servers/:id/start` | `{ projectDir }` | `{ server }` (status reflects the new state) |
| `POST`   | `/api/mcp/servers/:id/stop` | `{ projectDir }` | `{ ok }` |
| `GET`    | `/api/mcp/servers/:id/tools?projectDir=<abs>` | — | `{ tools: [{ name, description, inputSchema }] }` (forces a re-discovery) |
| `POST`   | `/api/mcp/call` | `{ projectDir, serverId, toolName, args }` | `{ ok, content: [...], isError? }` |

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

- **Server entries are project-scoped.** They live in `<projectDir>/.mcp.json` under `servers`, so they can be committed to the repo and reviewed by collaborators. Legacy `.mouaif.json` `mcp.servers` is read as a fallback.
- **Tool names are namespaced.** The model sees `mcp__<serverSlug>__<toolName>` (the standard MCP convention). Built-in tools (`shell`, future) use their own prefixes. The AI client routes `mcp__…` names through `mcp.callTool` and leaves the rest alone.
- **Discovery is cached on the session *and* persisted in the app store.** A successful `tools/list` lands on the server record's in-memory session and is also written to the app SQLite store (`mcp_tool_cache` table, keyed by project directory + server id). The AI client uses the live session when the server is running; it falls back to the persisted cache when the server is enabled but stopped (e.g. after a mouaif restart, or on a new chat before the auto-start fires). A tool call against a stopped server returns `EMCP_NOSESSION` — the honest signal — but the model still sees the surface and the user can tap Start. The cache is runtime state, not config, which is why it does not live in the project file; legacy inline `toolCache` entries are migrated into the store on first read.
- **Enabled servers auto-start on chat open.** `GET /api/tools/list` (which the chat UI calls on load) runs `ensureEnabledServers(projectDir)`: every enabled server that is not already `ready` / `starting` is spawned and re-discovered before the catalog is returned. Disabled servers stay stopped. A failed start is captured as `errored` on that server only — the rest of the enabled set still starts.
- **Tool calls ride the same SSE stream as the rest of the chat.** `tool_call` and `tool_result` are first-class events (decision §10). The chat UI renders them inline; the trace file (decision §5) writes them as `tool_call` / `tool_result` lines.
- **Errors are typed.** Transport failures become `EMCP_TRANSPORT`; JSON-RPC errors become `EMCP_RPC`; timeouts become `EMCP_TIMEOUT`; missing slugs become `EMCP_NOSESSION`; missing tools become `EMCP_NOTFOUND`; disabled servers become `EMCP_DISABLED`. The chat UI can branch on `code` without parsing the message.
- **Server args are not shell-parsed.** The `args` field is a whitespace-separated token list. Quoted multi-word args are not yet supported; a future revision can add a real `shlex`-style splitter.
- **Env denylist is enforced.** `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `NODE_DEBUG`, and a few related vars are stripped from the inherited env before the per-server env map is applied. The denylist does not strip keys the user explicitly set in the per-server env — the user can opt in to those if they want.
- **Server cwd must be inside the project.** Anything outside the project root is rejected with `EOUTSIDE_PROJECT`. The same rule decision §16 uses for `shell`.
- **No new SSE events for the AI client itself.** Tool dispatch reuses the existing `tool_call` / `tool_result` events; the AI client's parse path accumulates OpenAI-compatible `tool_call` deltas by index and flushes them when the upstream signals `finish_reason: tool_calls`.
- **Server child is tracked in-memory only.** A `process.exit` reaps the child; a crash surfaces as `errored` status with the typed code in the inline error.

## Implementation notes

- Source: [src/mcp.js](../../src/mcp.js). Public surface: `listServers`, `getServer`, `addServer`, `updateServer`, `removeServer`, `startServer`, `stopServer`, `stopAll`, `listDiscoveredTools`, `callTool`, `composedToolNameFor`, `listComposedToolSpecs`.
- Server wiring: [src/ai.js](../../src/ai.js) → `streamChat()`. After the upstream finishes streaming, accumulated `tool_call` deltas are dispatched through `mcp.callTool()`. Tool results are surfaced as `tool_result` SSE events, not fed back into the same stream.
- HTTP wiring: [src/index.js](../../src/index.js) → `handleMcp()`. The Settings UI hits the REST surface; the AI client never goes through HTTP.
- SDK isolation: the `@modelcontextprotocol/sdk` is loaded lazily in `getSdk()`. A failure to load the SDK (e.g. a fresh checkout with no `node_modules`) surfaces as `EMODULE` on every server action — the rest of the server boots cleanly without MCP.
- Frontend: [src/web/src/components/SettingsMcp.jsx](../../src/web/src/components/SettingsMcp.jsx) (list + editor views) and the home card on [src/web/src/components/SettingsHome.jsx](../../src/web/src/components/SettingsHome.jsx). Tool cards in the chat live in [src/web/src/components/Chat.jsx](../../src/web/src/components/Chat.jsx) → `appendToolCallCard` / `appendToolResultCard`.
- Lifecycle hookup: `mcp.installShutdown()` registers `process.once('exit' | 'SIGINT' | 'SIGTERM', ...)` to stop every running server child cleanly. Called from [src/index.js](../../src/index.js) at require time.

## Related

- [docs/features/ai-client.md](./ai-client.md) — `tool_call` and `tool_result` SSE events, the parse path that accumulates OpenAI-compatible deltas.
- [docs/features/tool-authorization.md](./tool-authorization.md) — the gate every tool call passes through.
- [docs/features/trace.md](./trace.md) (decision §5) — `tool_call` and `tool_result` lines on the NDJSON trace.
- Decision: [docs/decisions.md §18](../decisions.md) (this feature) and §10 (AI client wire format), §16 (the shell tool that established the tool model).
