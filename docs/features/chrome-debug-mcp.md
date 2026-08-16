# Chrome Debug MCP — model-driven browser automation

## Overview

The `chrome-debug` MCP server launches an isolated headless Chrome instance to enable AI-driven browser inspection and automation (`take_snapshot`, `click`, `type_text`, `navigate`, etc.) without requiring manual browser setup.

## Getting started

### Enabling browser automation

1. Navigate to **Settings → MCP**.
2. Find the **`chrome-debug`** row and tap **Start**.
3. In any chat in that project, the browser automation tools will become available to the model.

### Pairing with the Inspector

By default, the Inspector tab and the `chrome-debug` MCP server operate independently:

- **Inspector** connects to a user-configured debug endpoint (default: `http://127.0.0.1:9222`).
- **chrome-debug** launches its own isolated Chrome instance for the model's actions.

If you want both the Inspector UI and the model to share the exact same browser window, start Chrome with `--remote-debugging-port=9222` and set the MCP server argument to:

```bash
--browser-url=http://127.0.0.1:9222
```

## Behavior

- **Headless by default** — Chrome launches with an isolated temporary profile and no window, making it compatible with servers, containers, and desktop environments alike.
- **Custom executable path** — if Chrome is in a non-standard location, you can add `--executablePath=/path/to/chrome` in the server arguments.
- **Tool safety** — browser actions follow your project's tool authorization permissions (`Ask`, `Allow`, or `Off`).

## Related

- [MCP](./mcp.md) — managing Model Context Protocol servers.
- [Inspector](./inspector.md) — mobile DevTools inspection tab.
- [Tool authorization](./tool-authorization.md) — tool execution permissions.
