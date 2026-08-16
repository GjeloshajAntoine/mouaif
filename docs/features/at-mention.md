# @-mention autocomplete in the chat composer

## Overview

The chat composer supports `@` autocomplete: typing `@` followed by text shows a popup listing **files**, **tools/actions**, and the **current model**. The user can select an item with the keyboard (Arrow keys + Enter/Tab) or a tap, and the selection is inserted as `@<item>` into the composer text.

## Usage

- Type `@` anywhere in the chat composer. A popup appears above the composer showing:
  - **Files** — tagged project files first (with their tags listed in the search text), then scanned project text files (up to ~200). Each result shows the file name as its primary label and the project-relative folder underneath; root files show **Project root**. Selecting a file inserts `@<relPath>`.
  - **Agents** — the project's subagent personas (from Settings → Project → Agents), with their pinned model in the subtitle when set.
  - **Actions** — the project's available tools (shell, read_file, list_files, write_file, etc.).
  - **Model** — the currently selected model ID.
- Narrow the list by typing any part of a file name or folder path (case-insensitive search against label, full relative path, and tags). The 200-file display cap is applied after matching, so files and folders later in large project scans remain searchable.
- **At rest** (empty query), each category shows at most **4 items** so Files don't crowd out Agents, Actions, and Model. Start typing to drop the per-category cap and search the full list.
- Navigate with **Arrow Down/Up**, select with **Enter** or **Tab**, dismiss with **Escape** or click outside.
- The inserted `@<item>` stays visible in the composer text so the user can edit or remove it, or type arguments after the tool name.
- **Tools with known parameters** (from the server's `parameters` JSON Schema) insert `@toolName:firstArg=\`\`` with the cursor between the backticks, and show a **chip bar** below the textarea listing the remaining parameters. Tap a chip to append `key=\`\``. Required parameters are highlighted in bold/accent.
- The popup refreshes periodically (every 5 s) to pick up newly scanned files or changed tags.

## Direct agent invocation

When the composer text starts with `@` followed by a defined **agent name** and a non-empty task, pressing Enter dispatches that agent directly via `POST /api/tools/subagent` — no model round-trip decides whether to delegate:

```
@reviewer Check the staged changes for regressions.
```

The run renders as a `subagent` tool_call/tool_result card pair (like `/shell`), and the agent's final text is appended to the transcript as an assistant message so it persists across reloads. The call passes through the same authorization gate as a model-initiated `subagent` call, and honors the agent's tool allowlist and model pin. A leading `@<agent>` with no task, or an `@` in the middle of the text, falls through to a normal model send.

## Direct tool invocation with arguments

When the composer text starts with `@` followed by a directly-invocable tool name (shell or MCP tool), pressing Enter dispatches the tool immediately instead of sending the message to the model. Supported argument formats:

| Format | Example | Result |
|--------|---------|--------|
| **JSON** | `@mcp__fs__list { "path": "/etc" }` | `{ path: "/etc" }` |
| **key=value** | `@mcp__fs__read path=/etc recursive=true` | `{ path: "/etc", recursive: true }` |
| **Positional** | `@shell ls -la` | `{ cmd: "ls -la" }` (shell only) |

Rules:

- `@shell <cmd>` dispatches the native shell tool with `{ cmd: "<cmd>" }`.
- `@mcp__<server>__<tool> <args>` dispatches the MCP tool with parsed args.
- **Native file tools** (`read_file`, `list_files`, search_files`, etc.) are never dispatched directly — the `@` text is sent to the model, which can use the tool naturally.
- If `@` is in the middle of the text (not at the start), it is always sent to the model as a normal message — only the leading `@` triggers direct invocation.
- An `@` tool name with no parseable arguments also falls through to normal model send (the model can pick up the file reference).

The argument parser (`parseToolArgs` in `tools.js`) tries JSON first, then `key=value` pairs. Quotes in values allow spaces: `name="my file.js"`.

## Popup sections

| Section   | Source                                                  |
|-----------|---------------------------------------------------------|
| Files     | Tagged files from `.mouaif.json` (via `GET /api/projects/:id/tags`), then scanned files from `POST /api/projects/:id/tags/scan` |
| Agents    | Project agents (`GET /api/agents?projectDir=…`)         |
| Actions   | Tool catalog from the project settings (`state.tools.catalog`) |
| Model     | Current chat model (`state.chat.modelId`)              |

## Related

- [docs/features/file-tagging.md](./file-tagging.md) — the tag system that feeds the Files section.
- [docs/features/chat-ui.md](./chat-ui.md) — composer and message rendering.
- [docs/features/custom-prompts.md](./custom-prompts.md) — @ references are passed as `referencedPaths` to the server, promoting the injected file to `role: 'user'`.
