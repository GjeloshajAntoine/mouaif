# Tool Tree — implementation notes

> Agent-facing reference for [`docs/features/tool-tree.md`](../../features/tool-tree.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

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
  collapsedByDefault?: boolean,
  alwaysExpanded?: boolean
}
```

Project settings renders the tree with `collapsedByDefault: true`, so nested groups start closed and expand on tap. `alwaysExpanded` remains available for callers that want the children permanently visible with no collapse control.

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

### Group expansion survives toggles

The chat tools card rebuilds the tree in place on every checkbox toggle (`updateToolsCard` → `replaceChild`). To keep the currently expanded sections open instead of snapping shut, the card persists the collapse set on `state._toolTreeCollapsed` and passes it back as `initialCollapsed` on the rebuilt tree (via the `onCollapseChange` callback). `ToolTree` seeds its `collapsed` state from `initialCollapsed` when provided.

### Indeterminate (half-check) state

A group whose child tools are partially selected renders its checkbox in the browser's `indeterminate` state (with `aria-checked="mixed"`), so a partial selection is visually distinct from both "all on" and "all off". Because `indeterminate` is a DOM-only property — it has no HTML attribute — it is passed as a vnode prop (`indeterminate: halfChecked`) on the group `<input>`. Preact applies it as a DOM property on every render (it is on the `HTMLInputElement` prototype), and only rewrites `checked` when that value actually changes, so a toggled child never clobbers the half-check and, once every child is on, the prop sends `false` and the half-check clears instead of sticking. The custom checkbox CSS paints this state as a contrasting horizontal bar. It is purely presentational: clicking the group checkbox still runs the normal `onToggleGroup` handler (check → all on, uncheck → all off).

The composer popup's tree is rebuilt from `state.tools`, a mutable bag value, so a tool toggle rewrites it without itself re-rendering the `ToolPopup`. The chat tools card re-renders imperatively via `updateToolsCard`, but the popup needs a Preact re-render too — `useChatState` bumps `toolDataStamp` on every tool toggle so the popup recomputes its groups and keeps the half-check, expanded groups, and child states in sync.

### Settings auth groups

Authorization keys in the project file:

| Tree group | Auth key | Modes |
|---|---|---|
| shell | `tools.shell` | off / ask / allowlist / allow |
| subagent | `tools.subagent` | off / ask / allowlist / allow |
| ask_user | `tools.ask_user` | off / ask (binary) |
| File tools | `tools.file` | off / ask / allowlist / allow |
| (each MCP server) | `mcp.authorization.servers.<slug>` (segment + group checkbox) | off / ask / allowlist / allow |

The settings tree renders one group per configured MCP server (group checkbox = that server's override's `Off ↔ Ask`, segment = the full per-server authorization override showing the effective mode). Servers always render, even when stopped: `/api/tools/list` only reports running servers, so the settings page loads the merged server list from `/api/mcp/servers` and falls back to the cached tool list on the server record.

`buildSettingsToolGroups` in `SettingsProject.jsx` maps each group to its auth state and attaches the segment as `control`. The group checkbox maps to `off ↔ ask`; `allow` is only reachable via the segment so a stray tap never escalates privilege. MCP segments are shared with the chat view through `McpAuthSeg` in `frontend/src/components/settings/toolAuth.js` (which also computes the layered effective mode via `mcpEffective`); per-server writes go through `PUT /api/tools/authorization` with `{ mcp: { servers: { <slug>: ... } } }` and a `null` clears the override.

Server overrides are keyed by the server's canonical *slug*, but a hand-edited `.mcp.json` may key one by its display *`id`* instead — the two differ whenever the id contains characters `slugify` collapses (e.g. `id: "chrome-debug"` → `slug: "chrome_debug"`). A mismatch used to make the settings checkbox for that server silently show the shared default (wrongly reporting `default (ask)` / on) because the override was never found. `getAuthorization` in `src/tools/authorization.js` re-keys `mcp.servers` and the authorize-time lookup onto slugs (`mcpServersBySlug`), and `setAuthorization` also cleans the stale id-twin on write, so an id-keyed override reads and clears correctly regardless of which key the file uses.

### Filter semantics

The per-chat `tools` filter (chat record):

- `null` — all tools enabled (default)
- `[]` — no tools enabled
- `["shell", "read_file"]` — explicit selection

Checking every tool collapses the filter back to `null`; unchecking from `null` snapshots the full catalog minus the toggled tool.

### Styling

`frontend/src/tool-tree.css` — thin rows (`min-height: 26px` groups, `24px` leaves), `0.72rem` font, name and description on the same line separated by a space, ellipsis truncation. The `.tool-tree__control .seg__pill` override shrinks the auth segment to fit inside a row. Disabled rows get `.is-disabled` (reduced opacity, struck-through name) plus the inline `.tool-tree__reason` / `.tool-tree__leaf-reason` explanation text.
