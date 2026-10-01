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

### Group builders — one row shape everywhere

`ToolTree` is only the renderer; the `groups` array is produced by three builders in the same module. All three emit the **same row content** for a native tool — `name`, a `shortDesc`-clamped `description`, and the full text as `title` — so a tool reads identically wherever it is listed:

| Builder | Caller | Checked state comes from | Authorization control |
|---|---|---|---|
| `buildToolGroups(catalog, mcpServers, filter, usedTools)` | chat tools card (`chat/cards.js`), composer popup (`chat/ToolPopup.jsx`), prompt preset (`SettingsPrompts.jsx`) | the per-chat `tools` filter (`null` = all on) | yes — `ToolAuthSeg`, injected by the caller as `control` |
| `buildSettingsToolGroups(catalog)` | `SettingsProject.jsx` | the project's `tools.<name>.mode` | yes — `ToolAuthSeg` (via `toolModeSegs`) |
| `buildAgentToolGroups({ choices, restricted, selected, mcpServers, catalog })` | `SettingsAgents.jsx` | the agent's `tools` allowlist | no — see below |

`buildAgentToolGroups` takes the tool catalog (from `GET /api/tools/list`) purely to fill in the native rows' descriptions and tooltips; without it every single-tool row rendered as a bare checkbox + name, which is what made `subagent` look unlike its chat-view counterpart. It intentionally attaches **no** authorization segment: an agent allowlist decides which tools the nested call may use, while `Off / Ask / Allow` is a project-level setting shown in Settings → Project and the chat view.

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

### Toggle races

`toggleTool` delegates to `toggleToolGroup`, so single rows and group rows share one code path. Three rules keep a tapped checkbox from reverting:

- **Derive from the live filter.** The next filter is always computed from the current `state.tools`, and the write keeps the current catalog object, so a catalog refresh landing between taps is not overwritten.
- **The background catalog load keeps the live filter.** `/api/tools/list` can take seconds (MCP cold start). When it resolves, `useChatState` keeps `tools.current.filter` instead of restoring the filter captured at chat load — previously a checkbox flipped during that window snapped back in the tree while the PATCH had saved the new value.
- **Known names include cached MCP rows.** The "all on" snapshot and the collapse-to-`null` check use `knownToolNames(state)`: the live catalog plus each MCP server's cached `tools` list when it has no live entries (the same fallback `buildToolGroups` renders). Snapshotting only the live catalog while a server was starting silently unchecked all its rows, and toggling one of those rows was a no-op. The collapse check compares membership, not size, so stale names in a stored list do not pin the chat. Re-enabling from the implicit all-on state stays `null`.

A toggle for an unknown name does not PATCH but still re-renders the card, so a DOM checkbox the browser already flipped snaps back to the real state. PATCH ordering itself is handled by `updateChatBound` (per-chat queue + per-field tickets).

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
| Chats / mouaif (two category rows, one family) | `tools.mouaif` | off / ask / allowlist / allow |
| (each MCP server) | `mcp.authorization.servers.<slug>` (segment + group checkbox) | off / ask / allowlist / allow |

The settings tree renders one group per configured MCP server (group checkbox = that server's override's `Off ↔ Ask`, segment = the full per-server authorization override showing the effective mode). Servers always render, even when stopped: `/api/tools/list` only reports running servers, so the settings page loads the merged server list from `/api/mcp/servers` and falls back to the cached tool list on the server record.

`buildSettingsToolGroups` in `SettingsProject.jsx` maps each group to its auth state and attaches the segment as `control`. The group checkbox maps to `off ↔ ask`; `allow` is only reachable via the segment so a stray tap never escalates privilege.

### Categories: one tool, several rows

A category is a group row whose child rows are **parts of one tool** rather than separate tools. `mouaif` is the only one today: `GROUPS` in `src/tools/mouaif.js` splits its twelve actions into **Chats** (chats + attachments) and **mouaif** (settings, projects, feature info), and each category renders its own actions as children, so it is collapsible and counted like `File tools` instead of reading as one more single-child tool row (a one-child group in `ToolTree` hides its child).

Every child maps to the same authorization family, so:

- each child row carries `toolName` (the model-facing name, `mouaif`) beside its own tree id (`mouaif:list`); the per-chat tool filter stores **tool names**, so a toggle must resolve through `toolName` or the chat would be written with a tool that does not exist. That resolution lives in `groupToolNames(group)` / `childToolName(group, toolId)`, exported from `ToolTree.jsx` and called by BOTH chat surfaces (`cards.js` and `ToolPopup.jsx`). It is one shared pair on purpose: the first fix inlined the rule at each call site, landed in the popup and missed the card, so the card's action checkboxes pushed `mouaif:list`, `knownToolNames` in `toggleToolGroup` dropped the unknown name, and every tap on an action row was a silent no-op;
- the category checkbox and segment write the one `tools.mouaif` mode, and a child checkbox is the same `Off ↔ Ask` shortcut rather than a per-tool override (which would key on `mouaif`, not on the row's id);
- the two category rows therefore always agree, whichever surface changed them.

`MOUAIF_TOOL_GROUPS` in `frontend/src/components/ToolTree.jsx` holds the ids and the per-action child labels; the server's `GROUPS.actions` are derived from the `ACTIONS` area table, so a new action lands under its area's category with no second edit. Covered by `scripts/test-mouaif-tool.js` (server table), `scripts/test-mouaif-tool-categories.mjs` (rendered shape and child identity), and `scripts/test-mouaif-tool-toggle.mjs` (the resolvers, the real `toggleToolGroup` write, and both call sites resolving through the shared pair).

### One authorization control for every tool

`ToolAuthSeg` in `frontend/src/components/settings/toolAuth.js` is the single component that renders a tool's `Off / Ask / Allow` choice. Every surface uses it, so `subagent` is not special-cased anywhere — it goes through the same loop, the same props, and the same markup as `shell`, `task`, `ask_user`, and the file-family gate:

| Surface | Call site | Radio group |
|---|---|---|
| Chat tools card | `frontend/src/components/chat/cards.js` (`toolByGroup` map) | `chat-auth-<tool>` |
| Composer tool popup | `frontend/src/components/chat/ToolPopup.jsx` (`AuthSegment` wrapper) | `popup-auth-<tool>` |
| Project settings tree | `toolModeSegs` in the same module, re-exported by `frontend/src/components/settingsProjectUi.js` | `sp-<label>` |
| Generic settings card | `frontend/src/components/settings/ToolSettingCard.jsx` | `sp-<id>` |

Component contract: `tool` (authorization key), `name` (label / `aria-label`), `mode`, `allowlist`, `modes` (`TOOL_MODE_CHOICES` or `ASK_USER_MODE_CHOICES` for binary tools), `namePrefix` (so two cards on one page never share a radio group), and `onPick(mode, allowlist)`. `allowlist` mode displays as **Ask** and the patterns survive every mode change except `allow`, which clears them — the behavior each surface previously re-implemented by hand.

MCP segments are shared with the chat view through `McpAuthSeg` in the same module (which also computes the layered effective mode via `mcpEffective`); per-server writes go through `PUT /api/tools/authorization` with `{ mcp: { servers: { <slug>: ... } } }` and a `null` clears the override.

Server overrides are keyed by the server's canonical *slug*, but a hand-edited `.mcp.json` may key one by its display *`id`* instead — the two differ whenever the id contains characters `slugify` collapses (e.g. `id: "chrome-debug"` → `slug: "chrome_debug"`). A mismatch used to make the settings checkbox for that server silently show the shared default (wrongly reporting `default (ask)` / on) because the override was never found. `getAuthorization` in `src/tools/authorization.js` re-keys `mcp.servers` and the authorize-time lookup onto slugs (`mcpServersBySlug`), and `setAuthorization` also cleans the stale id-twin on write, so an id-keyed override reads and clears correctly regardless of which key the file uses.

### Filter semantics

The per-chat `tools` filter (chat record):

- `null` — all tools enabled (default)
- `[]` — no tools enabled
- `["shell", "read_file"]` — explicit selection

Checking every tool collapses the filter back to `null`; unchecking from `null` snapshots the full catalog minus the toggled tool.

### Styling

`frontend/src/tool-tree.css` — thin rows (`min-height: 26px` groups, `24px` leaves), `0.72rem` font, name and description on the same line separated by a space, ellipsis truncation. The `.tool-tree__control .seg__pill` override shrinks the auth segment to fit inside a row. Disabled rows get `.is-disabled` (reduced opacity, struck-through name) plus the inline `.tool-tree__reason` / `.tool-tree__leaf-reason` explanation text.
