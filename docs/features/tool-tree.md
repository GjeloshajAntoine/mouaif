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

Settings → Project shows the same tree, with each group row carrying its **authorization segment** on the same line: `Off / Ask / Allow` (or `Off / Ask` for binary tools like `ask_user`). The group checkbox is a shortcut for `Off ↔ Ask`; the segment is the only way to pick `Allow`. MCP renders exactly like the chat view: an **MCP default** row (the project gate) and one expandable row per configured MCP server. Each discovered MCP tool is a child checkbox, backed by `mcp.tools.<composedName>` React state: unchecking creates an `off` override and checking clears that override so the tool inherits its server/default mode. The leaf label omits the repeated `mcp__<server>__` prefix while retaining the composed name as its stable ID. The server checkbox remains the server override's `Off ↔ Ask` shortcut, and the segment edits the per-server override with a ↺ reset. The row description states whether the mode is an override or inherited (`override: ask` / `default (ask)`). Auto-approve patterns (the `allowlist` mode) are still honored when present in the project file, but the settings tree no longer renders a textarea for them — edit them from the raw `.mouaif.json` / `.mcp.json` in Technical details.

The settings tree replaces the old "Tool permissions" list — the UI is identical to the chat view so the mental model is the same: one tree, one place to look. Like the chat tree, groups with more than one nested tool start collapsed. The `ToolTree` holds its own collapse state, so a group the user expands stays open across SettingsProject re-renders (a checkbox or segment change only re-renders the tree in place). Because MCP server groups load asynchronously behind the native groups, `ToolTree` seeds any collapsible group that appears *after* its initial collapse set is built — so a late-arriving server group starts collapsed too — while an explicitly expanded group is preserved (the `flip` handler marks it `touched`, so the seed loop skips it).

File tools inherit from the `tools.file` family gate, while a leaf checkbox can persist a more-specific `tools.<tool_name>` override. This lets one operation be disabled without changing its siblings. The parent checkbox updates the family and all visible leaves together, so it settles directly on checked or unchecked rather than briefly becoming indeterminate. The authorization segment edits the shared family default while preserving explicit leaf overrides.

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
| MCP default | `mcp.authorization` (project gate in `.mcp.json`) | off / ask / allowlist / allow |
| (each MCP server) | `mcp.authorization.servers.<slug>` (segment + group checkbox) | off / ask / allowlist / allow |

The settings tree renders one group per configured MCP server (group checkbox = that server's override's `Off ↔ Ask`, segment = the full per-server authorization override showing the effective mode) plus a single **MCP default** row carrying the shared Off/Ask/Allow gate — every MCP tool call passes through it. Servers always render, even when stopped: `/api/tools/list` only reports running servers, so the settings page loads the merged server list from `/api/mcp/servers` and falls back to the cached tool list on the server record.

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
