# Chrome Debug MCP — model-driven browser automation

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

`.mcp.json` ships a preset MCP server entry, **`chrome-debug`**, that wraps Anthropic's [`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp) package and launches an isolated **headless** stable Chrome instance for browser automation. The result: the model gets a tool surface for driving a live page (`take_snapshot`, `click`, `type_text`, `navigate`, …) without requiring users to start Chrome with a debug port first, and without needing a desktop display (works on servers, CI, and Docker).

The entry is committed to `.mcp.json` so collaborators can review it, and starts Chrome through `chrome-devtools-mcp` with `--channel=stable --isolated --headless`. It is the canonical pattern for "let the model touch a real browser" without inventing a new transport — the existing MCP client ([src/mcp.js](../../src/mcp.js)) already does stdio, JSON-RPC, discovery, and gating. New MCP entries are disabled by default; flip the preset off in **Settings → MCP** if you don't want it starting Chrome.

> **Why headless?** On machines without an X server (headless Linux servers, containers), the headful launch fails with `Missing X server to start the headful browser`. The `--headless` flag makes the preset work there and everywhere. The `chrome-debug` tools operate through DevTools Protocol, so screenshots, snapshots, and page automation are identical either way.

## Usage

### Chrome startup

No separate Chrome startup is required. The preset passes these flags to `chrome-devtools-mcp`:

```bash
--channel=stable --isolated --headless --no-usage-statistics
```

That makes the MCP server launch stable Chrome headless with a temporary isolated profile on Linux, macOS, or Windows. **No display is required** — this is what makes the preset work on headless servers. If Chrome cannot be auto-detected on a machine, edit the row in **Settings → MCP** and add an explicit executable path, for example:

```bash
--executablePath=C:\Program Files\Google\Chrome\Application\chrome.exe
```

or on Linux:

```bash
--executablePath=/usr/bin/google-chrome
```

### Enable the preset

1. Open a chat in this project (or any project whose root is the repo containing `.mcp.json`).
2. **Settings → Project features → MCP servers**.
3. Find the **`chrome-debug`** row. Toggle **Enabled** on, tap **Start**.
4. Open a new chat. The transcript's **Tools available to the model** card shows the new tools, namespaced as `mcp__chrome_debug__<tool>`.

Once enabled, every open chat (current and future) sees the tools. The child process is in-memory only, so a `mouaif` restart will need a fresh **Start**; the discovered tool list is persisted in the app SQLite store so the model still sees the surface on a stopped server.

> **Heads-up:** if the server was started before the preset changed (e.g. the `--headless` fix was added to `.mcp.json`), restart `mouaif serve` once so the registry picks up the new args — the running process keeps the old in-memory config.

### Pairing with the Inspector

By default, the Inspector tab and the `chrome-debug` MCP server use separate Chrome connections:

- **Inspector** ([src/inspector.js](../../src/inspector.js)) connects to a user-configured CDP endpoint, defaulting to `http://127.0.0.1:9222`.
- **chrome-debug** spawns `chrome-devtools-mcp`, which launches its own isolated Chrome and opens CDP connections for whichever tools the model invokes.

If you need both surfaces on the exact same browser, edit the MCP row back to an explicit browser URL and start Chrome with `--remote-debugging-port=9222`:

```bash
--browser-url=http://127.0.0.1:9222
```

## Behavior

- **Preset ships enabled.** The entry in this repo's `.mcp.json` has `enabled: true` so the tools are available out of the box here; new MCP entries added through Settings are disabled by default. A `Start` while Chrome cannot be launched fails fast with `EMCP_START` and the inline error surfaces in the Settings row.
- **Chrome auto-launches headless.** The `--channel=stable --isolated --headless` flags make `chrome-devtools-mcp` start a stable Chrome with a temporary profile and no window — so it runs on machines without a display. Users with a non-standard install can edit the row in **Settings → MCP** and add `--executablePath=...`. To see the browser (desktop only), drop `--headless` from the args and relaunch the server.
- **No secrets in the entry.** The env block is empty; the package only needs the debug URL. Anything sensitive stays in the keyring ([docs/features/auth.md](./auth.md)).
- **Authorization defaults to `ask`.** MCP tool calls go through the same gate as the native tools ([docs/features/tool-authorization.md](./tool-authorization.md)). The user approves each `click` / `type_text` / `navigate` call before the runner executes, or flips the **MCP tools** mode to **Allow** (or adds auto-approve patterns) at the top of **Settings → MCP**.
- **Args are not shell-parsed.** Each flag is a single token passed straight to the child; the same rule as every other MCP server (decision §18).
- **Artifact paths stay in the project.** Chrome tools inherit mouaif's generic MCP output-path handling: project-relative artifact paths are converted to absolute project paths, and MCP `roots/list` exposes the active project. See [MCP](./mcp.md).
- **Failure is contained.** A `chrome-debug` crash surfaces as `EMCP_TRANSPORT` and marks just that server `errored` — the rest of the chat (and every other MCP server) keeps running.

## Implementation notes

- Source: this is a **config-only change** — `.mcp.json` carries the new entry; no source code is touched. The runtime surface is the existing [src/mcp.js](../../src/mcp.js) (registry + stdio client) and [src/tools/authorization.js](../../src/tools/authorization.js) (the authorization gate that wraps every tool call).
- Inspector host source: [src/inspector.js](../../src/inspector.js) → `defaultDebuggerUrl()` resolves to `MOUAIF_CHROME_URL` or `http://127.0.0.1:9222`. The MCP preset intentionally does not mirror that default; it favors zero-setup browser launch unless the user opts back into `--browser-url=...`.
- MCP preset shape: see [docs/features/mcp.md](./mcp.md) for the full server-entry contract (`name`, `slug`, `command`, `args`, `env`, `cwd`, `enabled`, `createdAt`; the last-known tool list is cached in the app store, not in the file).
- Tool routing: when the model emits a `tool_call` whose name starts with `mcp__chrome_debug__`, [src/ai.js](../../src/ai.js) `streamChat()` parses the slug, dispatches through `mcp.callTool()`, and the result rides the same `tool_call` / `tool_result` SSE events as any other tool.

## Related

- [docs/features/mcp.md](./mcp.md) — the registry that owns the entry.
- [docs/features/inspector.md](./inspector.md) — the custom CDP UI that can still be paired with this preset when both use an explicit browser URL.
- [docs/features/tool-authorization.md](./tool-authorization.md) — the gate every `mcp__chrome_debug__*` call passes through.
