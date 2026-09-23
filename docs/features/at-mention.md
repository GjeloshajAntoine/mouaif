# @-mention autocomplete in the chat composer

## Overview

The chat composer supports `@` autocomplete: typing `@` followed by text shows a popup listing **files**, **agents**, **project actions**, **native tools**, **MCP tools**, and the **current model**. Actions, native tools, and MCP server tools have separate categories so their roles remain clear. The user can select an item with the keyboard (Arrow keys + Enter/Tab) or a tap, and the selection is inserted as `@<item>` into the composer text.

## Usage

- Type `@` anywhere in the chat composer. A popup appears above the composer showing:
- **Files** — tagged project files first (with their tags listed in the search text), then scanned project text files (up to ~200). Each result shows the file name as its primary label and the project-relative folder underneath; root files show **Project root**. Selecting a file inserts `@<relPath>`.
- **Agents** — the project's subagent personas (from Settings → Project → Agents), with their pinned model in the subtitle when set.
- **Actions** — only the project's saved custom actions from Settings → Project → Custom actions. Rows show the user-facing label and description, not whether the saved implementation uses CLI or MCP.
- **Tools** — native tools such as shell, file tools, `ask_user`, and `task`. They remain selectable but are no longer mislabeled as actions.
- **MCP** — tools exposed directly by running MCP servers. Each row uses a plug icon and shows its server and description.
- **Model** — the currently selected model ID.
- Narrow the list by typing any part of a file name or folder path (case-insensitive search against label, full relative path, and tags). The 200-file display cap is applied after matching, so files and folders later in large project scans remain searchable.
- **Matching files always appear first**, ahead of matching agents, actions, tools, MCP tools, and the model. Relevance order is preserved within the file and non-file groups.
- **At rest** (empty query), a **category filter bar** sits at the top of the popup with chippable types: **Files**, **Agents**, **Actions**, **Tools**, **MCP**, **Model**. Tap a chip to show **only** that category (with its full list rather than the 4-item cap); tap the active chip again to return to the mixed "All" view. When a type has no items (e.g. no model configured), the bar stays visible so you can switch back instead of losing the popup. The filter applies only while the popup is open; it resets to "All" each time a fresh `@` is typed.
- In the mixed "All" view, each category shows at most **4 items** so Files don't crowd out Agents, Actions, Tools, MCP, and Model. Start typing to drop the per-category cap and search the full list across every category (the filter bar hides while searching).
- Navigate with **Arrow Down/Up**, select with **Enter** or **Tab**, dismiss with **Escape** or click outside. For a complete custom action, press Enter to run it directly from the popup; an exact action ID takes precedence over similarly named file suggestions and works even when the composer normally uses Enter for a newline.
- The inserted `@<item>` stays visible in the composer text so the user can edit or remove it, or type arguments after the tool name.
- **Tools with known parameters** (from the server's `parameters` JSON Schema) insert ``` @toolName:firstArg=`` ``` with the cursor between the backticks, and show a **chip bar** below the textarea listing the remaining parameters. Tap a chip to append ``` key=`` ```. Required parameters are highlighted in bold/accent. This generated colon/backtick syntax dispatches directly for MCP tools. The inserted description is a placeholder: the caret lands immediately after the opening backtick, so the user's first keystroke replaces it. Regression test: [scripts/test-at-mention-caret.js](../../scripts/test-at-mention-caret.js).
- The popup refreshes periodically (every 5 s) to pick up newly scanned files, changed tags, or changed custom actions. Its refreshed custom-action list is also used for direct dispatch, so an action shown in the popup runs without reopening the chat.

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
| **Picker syntax** | `` @mcp__fs__read:path=`/etc/my file` `` | `{ path: "/etc/my file" }` |
| **Positional** | `@shell ls -la` | `{ cmd: "ls -la" }` (shell only) |

Rules:

- `@shell <cmd>` dispatches the native shell tool with `{ cmd: "<cmd>" }`.
- `@mcp__<server>__<tool> <args>` dispatches the MCP tool with parsed args. The direct call uses the catalog's stable MCP server ID plus the current chat/call IDs, so the normal per-tool authorization gate still applies without a model round-trip.
- **Native file tools** (`read_file`, `list_files`, search_files`, etc.) are never dispatched directly — the `@` text is sent to the model, which can use the tool naturally.
- If `@` is in the middle of the text (not at the start), it is always sent to the model as a normal message — only the leading `@` triggers direct invocation.
- An `@` tool name with no parseable arguments also falls through to normal model send (the model can pick up the file reference).

The argument parser (`parseToolArgs` in `tools.js`) tries JSON first, then `key=value` pairs. Quotes in values allow spaces: `name="my file.js"`.

## Popup sections

The popup is a mixed list, filtered either by the category bar at the top or by typing a query. The categories are defined in `frontend/src/components/chat/atMention.js` (`CATEGORY`).

| Section   | Source                                                  |
|-----------|---------------------------------------------------------|
| Files     | Tagged files from `.mouaif.json` (via `GET /api/projects/:id/tags`), then scanned files from `POST /api/projects/:id/tags/scan` |
| Agents    | Project agents (`GET /api/agents?projectDir=…`)         |
| Actions   | Project custom actions from `GET /api/actions?projectDir=…` |
| Tools     | Native entries from the project tool catalog (`state.tools.catalog`) |
| MCP       | `kind: "mcp"` entries from the project tool catalog, grouped separately from Actions and Tools |
| Model     | Current chat model (`state.chat.modelId`)              |

## Related

- [docs/features/file-tagging.md](./file-tagging.md) — the tag system that feeds the Files section.
- [docs/features/chat-ui.md](./chat-ui.md) — composer and message rendering.
- [docs/features/custom-prompts.md](./custom-prompts.md) — @ references are passed as `referencedPaths` to the server, promoting the injected file to `role: 'user'`.
