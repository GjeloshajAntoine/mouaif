# Tool Tree

## Overview

The tool tree is a compact, hierarchical list that shows every tool the model can use, with checkboxes for visibility and inline authorization controls. It replaces the old stacked permissions UI and chip toggles with a single thin tree that is the same in the chat view and in project settings.

## Usage

### Chat view

The tree sits below the system prompt. It shows one group per tool family:

- **shell** — run terminal commands
- **subagent** — delegate a task to a nested AI call
- **ask_user** — pause and ask the user a structured question
- **File tools** — read_file, list_files, search_files, write_file, edit_file
- **One group per MCP server** — configured servers always render, even when stopped; stopped servers fall back to the cached tool list from their last run. The group checkbox enables/disables the server itself (project-level); leaf checkboxes flip the per-chat tool filter.

Each group row has:

- a **checkbox** that toggles every child tool at once
- the group name
- a short one-line description (truncated, with a tooltip for the full text)
- a **collapse chevron** (only when there is more than one child)
- a **count badge** (`3/5`) when partially checked

Leaf rows are individual tools. Only the checkbox is clickable — the row text is inert, so tapping a name never toggles anything accidentally. Tools that have been called in the current chat show a blue dot (`●`) and are automatically checked ("started when used").

### Project settings

Settings → Project shows the same tree, but each group row also carries its **authorization segment** on the same line: `Off / Ask / Allow` (or `Off / Ask` for binary tools like `ask_user`). The group checkbox is a shortcut for `Off ↔ Ask`; the segment is the only way to pick `Allow`. When `Ask` is selected an auto-approve allowlist disclosure appears under the row.

The settings tree replaces the old "Tool permissions" list — the UI is identical to the chat view so the mental model is the same: one tree, one place to look.

## Implementation notes

### Component

`ToolTree.jsx` (`src/web/src/components/ToolTree.jsx`) renders the tree. Props:

```jsx
{
  groups: Array<{
    id, name, description?, checked, disabled?, title?,
    control?: any,                 // right-aligned Preact node (e.g. auth segment)
    extra?: any,                   // below-row node (e.g. allowlist disclosure)
    tools: Array<{ id, name, description?, title?, checked, disabled?, used? }>
  }>,
  onToggleGroup: (groupId, checked) => void,
  onToggleTool: (groupId, toolId, checked) => void,
  collapsedByDefault?: boolean
}
```

### Short descriptions

`shortDesc(text, max = 40)` clamps catalog descriptions to one line:

- Cut at the first sentence boundary (`. `) when it fits
- Hard-cap at `max` chars with an ellipsis
- The full text survives in the row's `title` tooltip

### Auto-check on use

When a `tool_call` SSE event arrives, `markToolUsed(state, refs, name)` in `stream.js`:

1. Adds the tool to `state.usedTools` (the dot badge)
2. If the per-chat filter is an explicit array and the tool is missing, calls `state._toggleTool(name, true)` to check it
3. Re-renders the tools card in place

`state.usedTools` is reset when the chat switches.

### Settings auth groups

Authorization keys in the project file:

| Tree group | Auth key | Modes |
|---|---|---|
| shell | `tools.shell` | off / ask / allowlist / allow |
| subagent | `tools.subagent` | off / ask / allowlist / allow |
| ask_user | `tools.ask_user` | off / ask (binary) |
| File tools | `tools.file` | off / ask / allowlist / allow |
| (each MCP server) | server `enabled` flag in `.mcp.json` | on / off via the group checkbox |
| MCP authorization | `mcp.authorization` (in `.mcp.json`) | off / ask / allowlist / allow |

The settings tree renders one group per configured MCP server (enable/disable) plus a single "MCP authorization" row carrying the shared Off/Ask/Allow gate — every MCP tool call passes through it. Servers always render, even when stopped: `/api/tools/list` only reports running servers, so the group builder falls back to the cached tool list on the server record.

`buildSettingsToolGroups` in `SettingsProject.jsx` maps each group to its auth state and attaches the segment as `control`. The group checkbox maps to `off ↔ ask`; `allow` is only reachable via the segment so a stray tap never escalates privilege.

### Filter semantics

The per-chat `tools` filter (chat record):

- `null` — all tools enabled (default)
- `[]` — no tools enabled
- `["shell", "read_file"]` — explicit selection

Checking every tool collapses the filter back to `null`; unchecking from `null` snapshots the full catalog minus the toggled tool.

### Styling

`src/web/src/tool-tree.css` — thin rows (`min-height: 26px` groups, `24px` leaves), `0.72rem` font, name and description on the same line separated by a space, ellipsis truncation. The `.tool-tree__control .seg__pill` override shrinks the auth segment to fit inside a row.
