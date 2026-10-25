# Chrome Debug MCP — model-driven browser automation

## Overview

The `chrome-debug` MCP server gives the model browser inspection and automation (`take_snapshot`, `click`, `type_text`, `navigate`, etc.). The repository's `.mcp.json` attaches it to the Chrome already listening on `http://127.0.0.1:9222` — the same browser the Inspector uses — instead of launching a new one.

## Getting started

### Enabling browser automation

1. Navigate to **Settings → MCP**.
2. Find the **`chrome-debug`** row and tap **Start**.
3. In any chat in that project, the browser automation tools will become available to the model.

### Sharing one browser with the Inspector

The server runs with `--browser-url=http://127.0.0.1:9222`, so the Inspector and the model share one browser. Start that Chrome with `--remote-debugging-port=9222` before the server's first tool call; if nothing listens there, the tool call fails instead of starting a browser. In the Docker UI-review stack the same URL reaches the stack's own `chrome` service, which has its own CPU and memory cap.

A server started with `--isolated --headless` instead launches its own Chrome and keeps it for as long as the server runs, even when no chat is using it. Each one holds about 0.5 GiB and keeps a renderer busy, so on a small host the extra browsers add up quickly.

## Behavior

- **No browser of its own** — the server attaches to the running Chrome and never starts another one.
- **Custom executable path** — if Chrome is in a non-standard location, you can add `--executablePath=/path/to/chrome` in the server arguments.
- **Tool safety** — browser actions follow your project's tool authorization permissions (`Ask`, `Allow`, or `Off`).

## Related

- [MCP](./mcp.md) — managing Model Context Protocol servers.
- [Inspector](./inspector.md) — mobile DevTools inspection tab.
- [Tool authorization](./tool-authorization.md) — tool execution permissions.
