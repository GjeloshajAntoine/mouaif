# Tool Tree

## Overview

The tool tree is a compact, hierarchical list that shows every tool the model can use, with checkboxes for visibility and inline authorization controls. It replaces the old stacked permissions UI and chip toggles with a single thin tree that is the same in the chat view, the composer's tool popup, and project settings.

## Usage

### Chat view

The tree sits below the system prompt. It shows one group per tool family:

- **shell** — run terminal commands
- **subagent** — delegate a task to a nested AI call
- **ask_user** — pause and ask the user a structured question
- **File tools** — read_file, list_files, search_files, write_file, edit_file
- **MCP default** — the project's shared MCP authorization gate (rendered when at least one MCP server is configured)
- **One group per MCP server** — configured servers always render, even when stopped; stopped servers fall back to the cached tool list from their last run. The group checkbox flips all the server's tools in the per-chat tool filter at once (there is no server-level on/off); leaf checkboxes flip individual tools.

Each group row has:

- a **checkbox** that toggles every child tool at once — it shows a **half-check (indeterminate)** state when some but not all of the group's child tools are on, so a partial selection is visible at a glance
- the group name
- a short one-line description (truncated, with a tooltip for the full text)
- a **collapse chevron** (only when there is more than one child)
- a **count badge** (`3/5`) when partially checked
- an **authorization segment** (`Off / Ask / Allow`) — every group carries one, MCP included: the **MCP default** row edits the shared gate (`mcp.mode`), and each MCP server row edits that server's override (`mcp.servers.<slug>`), showing the *effective* mode and a ↺ reset only when an override is set.

Leaf rows are individual tools. Only the checkbox is clickable — the row text is inert, so tapping a name never toggles anything accidentally. Tools that have been called in the current chat show a blue dot (`●`) and are automatically checked ("started when used").

### Project settings

Settings → Project shows the same tree, with each group row carrying its **authorization segment** on the same line: `Off / Ask / Allow` (or `Off / Ask` for binary tools like `ask_user`). The group checkbox is a shortcut for `Off ↔ Ask`; the segment is the only way to pick `Allow`. MCP renders exactly like the chat view: an **MCP default** row (the project gate) and one row per configured MCP server — the checkbox is that server's override's `Off ↔ Ask` shortcut, and the segment edits the per-server override with a ↺ reset. The row description states whether the mode is an override or inherited (`override: ask` / `default (ask)`). Auto-approve patterns (the `allowlist` mode) are still honored when present in the project file, but the settings tree no longer renders a textarea for them — edit them from the raw `.mouaif.json` / `.mcp.json` in Technical details.

The settings tree replaces the old "Tool permissions" list — the UI is identical to the chat view so the mental model is the same: one tree, one place to look.

## Implementation notes

### Component

`ToolTree.jsx` (`frontend/src/components/ToolTree.jsx`) renders the tree. Props:

```jsx
{
  groups: Array<{
    id, name, description?, checked, disabled?, disabledReason?, title?,
    control?: any,                 // right-aligned Preact node (e.g. auth segment)
    extra?: any,                   // below-row node (e.g. allowlist disclosure)
    tools: Array<{ id, name, description?, title?, checked,
                   disabled?, disabledReason?, used? }>
  }>,
  onToggleGroup: (groupId, checked) => void,
  onToggleTool: (groupId, toolId, checked) => void,
  collapsedByDefault?: boolean
}
```

### Disabled rows explain themselves

A greyed-out control with no reason is a dead end, so every `disabled` row carries a `disabledReason` string that the tree renders under the row (`.tool-tree__reason` for groups, `.tool-tree__leaf-reason` for leaves) and in the row's `title` tooltip. MCP server groups are **no longer disabled** — servers are always on and their group/leaf checkboxes flip the per-chat or per-server tool filter. The `disabled` pattern still covers project-locked groups (agent files, skills) in the chat popup.

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

### Indeterminate (half-check) state

A group whose child tools are partially selected renders its checkbox in the browser's `indeterminate` state (with `aria-checked="mixed"`), so a partial selection is visually distinct from both "all on" and "all off". Because `indeterminate` is a DOM-only property — it has no HTML attribute and would be stripped from the vdom — it is applied through a `ref` callback on the group `<input>` each render. The custom checkbox CSS paints this state as a contrasting horizontal bar. It is purely presentational: clicking the group checkbox still runs the normal `onToggleGroup` handler (check → all on, uncheck → all off).

### Settings auth groups

Authorization keys in the project file:

| Tree group | Auth key | Modes |
|---|---|---|
| shell | `tools.shell` | off / ask / allowlist / allow |
| subagent | `tools.subagent` | off / ask / allowlist / allow |
| ask_user | `tools.ask_user` | off / ask (binary) |
| File tools | `tools.file` | off / ask / allowlist / allow |
| MCP default | `mcp.authorization` (project gate in `.mcp.json`) | off / ask / allowlist / allow |
| (each MCP server) | `mcp.authorization.servers.<slug>` (segment + group checkbox) | off / ask / allowlist / allow |

The settings tree renders one group per configured MCP server (group checkbox = that server's override's `Off ↔ Ask`, segment = the full per-server authorization override showing the effective mode) plus a single **MCP default** row carrying the shared Off/Ask/Allow gate — every MCP tool call passes through it. Servers always render, even when stopped: `/api/tools/list` only reports running servers, so the settings page loads the merged server list from `/api/mcp/servers` and falls back to the cached tool list on the server record.

`buildSettingsToolGroups` in `SettingsProject.jsx` maps each group to its auth state and attaches the segment as `control`. The group checkbox maps to `off ↔ ask`; `allow` is only reachable via the segment so a stray tap never escalates privilege. MCP segments are shared with the chat view through `McpAuthSeg` in `frontend/src/components/settings/toolAuth.js` (which also computes the layered effective mode via `mcpEffective`); per-server writes go through `PUT /api/tools/authorization` with `{ mcp: { servers: { <slug>: ... } } }` and a `null` clears the override.

### Filter semantics

The per-chat `tools` filter (chat record):

- `null` — all tools enabled (default)
- `[]` — no tools enabled
- `["shell", "read_file"]` — explicit selection

Checking every tool collapses the filter back to `null`; unchecking from `null` snapshots the full catalog minus the toggled tool.

### Styling

`frontend/src/tool-tree.css` — thin rows (`min-height: 26px` groups, `24px` leaves), `0.72rem` font, name and description on the same line separated by a space, ellipsis truncation. The `.tool-tree__control .seg__pill` override shrinks the auth segment to fit inside a row. Disabled rows get `.is-disabled` (reduced opacity, struck-through name) plus the inline `.tool-tree__reason` / `.tool-tree__leaf-reason` explanation text.
