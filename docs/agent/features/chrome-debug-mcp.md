# Chrome Debug MCP — model-driven browser automation — implementation notes

> Agent-facing reference for [`docs/features/chrome-debug-mcp.md`](../../features/chrome-debug-mcp.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Source: this is a **config-only change** — `.mcp.json` carries the new entry; no source code is touched. The runtime surface is the existing [src/mcp.js](../../src/mcp.js) (registry + stdio client) and [src/tools/authorization.js](../../src/tools/authorization.js) (the authorization gate that wraps every tool call).
- Inspector host source: [src/inspector.js](../../src/inspector.js) → `defaultDebuggerUrl()` resolves to `MOUAIF_CHROME_URL` or `http://127.0.0.1:9222`. The MCP preset intentionally does not mirror that default; it favors zero-setup browser launch unless the user opts back into `--browser-url=...`.
- MCP preset shape: see [docs/features/mcp.md](./mcp.md) for the full server-entry contract (`name`, `slug`, `command`, `args`, `env`, `cwd`, `createdAt`; the last-known tool list is cached in the app store, not in the file).
- Tool routing: when the model emits a `tool_call` whose name starts with `mcp__chrome_debug__`, [src/ai.js](../../src/ai.js) `streamChat()` parses the slug, dispatches through `mcp.callTool()`, and the result rides the same `tool_call` / `tool_result` SSE events as any other tool.
