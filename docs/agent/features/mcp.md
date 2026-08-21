# MCP — Model Context Protocol servers — implementation notes

> Agent-facing reference for [`docs/features/mcp.md`](../../features/mcp.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| `GET`    | `/api/mcp/servers?projectDir=<abs>` | `projectDir` optional — without it only app-scoped servers; with it the merged app + project view | `{ servers: [{ id, name, slug, transport, command, url, args, env, headers, cwd, scope, status, tools? }] }` |
| `POST`   | `/api/mcp/servers` | `{ projectDir?, scope?, transport?, name, command?, url?, headers?, args?, env?, cwd? }` — `transport` is `'stdio'` (default) or `'http'`; `scope` is `'project'` (default, requires `projectDir`) or `'app'` | `{ server }` (201) |
| `PATCH`  | `/api/mcp/servers/:id` | `{ projectDir?, transport?, name?, command?, url?, headers?, args?, env?, cwd? }` — `scope` is fixed at creation and ignored in patches | `{ server }` (stops running session) |
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

## Implementation notes

- Source: [src/mcp.js](../../src/mcp.js). Public surface: `listServers`, `getServer`, `addServer`, `updateServer`, `removeServer`, `startServer`, `stopServer`, `stopAll`, `listDiscoveredTools`, `callTool`, `composedToolNameFor`, `listComposedToolSpecs`, `resolveMerged`. The merged app + project view comes from `resolveMerged(projectDir)`; scope-aware writes route through `findServerAnyScope` so a shadowed app entry stays editable. `startServer()` picks `StdioClientTransport` or `StreamableHTTPClientTransport` from the SDK based on `entry.transport`.
- Server wiring: [src/ai.js](../../src/ai.js) → `streamChat()`. After the upstream finishes streaming, accumulated `tool_call` deltas are dispatched through `mcp.callTool()`. Tool results are surfaced as `tool_result` SSE events, not fed back into the same stream.
- HTTP wiring: [src/http-server.js](../../src/http-server.js) → `handleMcp()` in [src/server-handlers-misc.js](../../src/server-handlers-misc.js). The Settings UI hits the REST surface; the AI client never goes through HTTP.
- SDK isolation: the `@modelcontextprotocol/sdk` is loaded lazily in `getSdk()`. A failure to load the SDK (e.g. a fresh checkout with no `node_modules`) surfaces as `EMODULE` on every server action — the rest of the server boots cleanly without MCP.
- Frontend: [frontend/src/components/SettingsMcp.jsx](../../frontend/src/components/SettingsMcp.jsx) (list + editor views) and the home card on [frontend/src/components/SettingsHome.jsx](../../frontend/src/components/SettingsHome.jsx). Tool cards in the chat are rendered by `appendToolCallCard` / `appendToolResultCard` in [frontend/src/components/chat/transcript.js](../../frontend/src/components/chat/transcript.js).
- Lifecycle: running MCP server children are stopped on `/api/restart` (`mcp.stopAll()` inside `handleRestart` in [src/server-handlers-misc.js](../../src/server-handlers-misc.js)). App-scoped configuration may run in multiple contexts: an app-settings process uses the `app` context, while each project starts its own process so `roots/list` always identifies that project's canonical root.
- Artifact paths: `resolveMcpOutputPaths()` canonicalizes `filePath`, `outputPath`, `outputDirPath`, `requestFilePath`, and `responseFilePath`. It accepts either a project's symlink alias or real on-disk path, then rejects lexical and symlink escapes before MCP dispatch.
