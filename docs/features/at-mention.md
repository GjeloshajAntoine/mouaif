# @-mention autocomplete in the chat composer

## Overview

The chat composer supports `@` autocomplete: typing `@` followed by text shows a popup listing **files**, **tools/actions**, and the **current model**. The user can select an item with the keyboard (Arrow keys + Enter/Tab) or a tap, and the selection is inserted as `@<item>` into the composer text.

## Usage

- Type `@` anywhere in the chat composer. A popup appears above the composer showing:
  - **Files** — tagged project files first (with their tags listed in the search text), then scanned project text files (up to ~200). Selecting a file inserts `@<relPath>`.
  - **Actions** — the project's available tools (shell, read_file, list_files, write_file, etc.).
  - **Model** — the currently selected model ID.
- Narrow the list by typing more characters (case-insensitive search against label, path, and tags).
- Navigate with **Arrow Down/Up**, select with **Enter** or **Tab**, dismiss with **Escape** or click outside.
- The inserted `@<item>` stays visible in the composer text so the user can edit or remove it, or type arguments after the tool name.
- **Tools with known parameters** (from the server's `parameters` JSON Schema) insert `@toolName:firstArg=\`\`` with the cursor between the backticks, and show a **chip bar** below the textarea listing the remaining parameters. Tap a chip to append `key=\`\``. Required parameters are highlighted in bold/accent.
- The popup refreshes periodically (every 5 s) to pick up newly scanned files or changed tags.

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
| Actions   | Tool catalog from the project settings (`state.tools.catalog`) |
| Model     | Current chat model (`state.chat.modelId`)              |

## Implementation notes

- Source: `src/web/src/components/chat/atMention.js` — standalone imperative module. Mounted and unmounted via `mountAtMention(textarea, popupEl, preactState, argBarEl)` which returns a cleanup function. The 4th argument is a `<div>` that receives parameter suggestion chips.
- `mountAtMention` accepts an optional 4th argument — the arg bar DOM node. When missing, no chips are shown.
- The server's `/api/tools/list` now includes `parameters` (JSON Schema `{ properties, required }`) for every tool. File tool parameters come from `SPECS`; MCP tool parameters come from `listComposedToolSpecs` via the MCP SDK.
- The popup `<div>` lives inside `.chat-view__composer` as its first child (before the buttons and textarea), positioned above the textarea with `position: absolute; bottom: 100%`.
- State is module-level (one instance). The `uiState` reference points to the Preact mutable state bag so `buildItems` can read project dir, tools catalog, and chat model without passing them on every keystroke.
- Files are fetched on mount and every 5 s via a `setInterval` in the `ChatView` mount effect. The scan endpoint is called once per project-dir change (cached in `scanCache`).
- The `@` detection walks backwards from the cursor to find `@` preceded by whitespace or start-of-string. The query ends at the cursor and cannot contain whitespace.
- **Direct invocation** happens in `stream.js` `send()` — the popup itself never invokes tools. It always inserts `@<name>` into the composer, and the typed-Enter path in `send()` decides whether to dispatch (shell/MCP at start-of-text with args) or send to the model.
- Argument parsing in `tools.js` (`parseToolArgs`): tries JSON first, then `key=value` pairs. Unparseable text returns `null`, causing the tool dispatch to skip and fall through to normal model send.
- **Arg bar:** When a tool with `parameters` is selected, `selectItem()` calls `renderArgBar(props, required, filled)` which creates a chip for each unfilled parameter. Required args are marked with `.is-required` (bold/accent border). `appendArg(key, prop)` appends ` key=\`\`` for string types or ` key= ` for booleans/numbers, then updates the bar to remove the filled chip. The bar is cleared when a non-tool item (file, model) is selected or the popup is remounted.
- Mobile-first: the popup is full-width inside the composer, capped at 240 px height with scroll, uses system font stacks and touch-friendly tap targets (≥ 36 px). The arg bar uses small chips (22 px height) that wrap to a second row on narrow screens.

## Related

- [docs/features/file-tagging.md](./file-tagging.md) — the tag system that feeds the Files section.
- [docs/features/chat-ui.md](./chat-ui.md) — composer and message rendering.
- [docs/features/custom-prompts.md](./custom-prompts.md) — @ references are passed as `referencedPaths` to the server, promoting the injected file to `role: 'user'`.