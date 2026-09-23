# Tool popup — implementation notes

> Agent-facing reference for [`docs/features/tool-popup.md`](../../features/tool-popup.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

The chat keeps tool catalogs, MCP servers, agent files, skills, and authorization data in refs because the transcript renderer also consumes them imperatively. After the initial chat load populates those refs, a lightweight render stamp refreshes the popup props so opening it cannot show a stale “No tools available” state.

- **File:** `frontend/src/components/chat/ToolPopup.jsx` — Preact component with two states (closed trigger button, open popup).
- **CSS:** `frontend/src/chat-composer.css` (`.tool-popup*` classes under the *Tool popup* section).
- Reuses the existing `ToolTree` Preact component from `frontend/src/components/ToolTree.jsx` and the `buildToolGroups` helper.
- Auth segments reuse the same `.seg` / `.seg__item` / `.seg__pill` classes from `frontend/src/settings.css`, with compact overrides scoped under `.tool-popup`.
- Outside-click and Escape-key close the popup.
- **Positioning:** the dialog opens *downward* from the trigger (`top: calc(100% + 4px)`), because the trigger sits in the chat head row near the top of the viewport — matching the model picker and chat switcher popovers in the same row. It is capped at `92vw` wide and `60dvh` tall with a scrollable body.
- **Mobile (< 480 px):** the dialog stays a compact popover instead of expanding into a full-screen sheet. Its width is capped to the viewport, and its scrollable height is capped to the measured space between the trigger's bottom and the visual viewport bottom so it cannot overflow downward past the composer and tab bar. The layout-neutral wrapper avoids pointer-event coupling between sizing and interactive controls.

The popup is viewport-fixed but anchored from the globe trigger and the full `.chat-view__head` bounds. Its height is capped by the remaining visual viewport, `60dvh`, and `400px`; the tool tree body scrolls while the header, close control, and auto-retry footer remain reachable.

Both tree surfaces render the same `ToolTree` component, so every control it can draw has to be wired on both sides. The MCP start control was not: the popup rendered `ToolTree` without `onReloadServer`, so its **…** button had no handler and tapping it did nothing, while the transcript card's identical button started the server. The start action now lives on the chat state hook (`state._startMcpServer`), which sets the busy marker, calls `POST /api/mcp/servers/:id/start`, refreshes the server list and tool catalog, and re-renders both surfaces. The popup receives it as `onReloadMcpServer` plus the `mcpStartBusy` id, and the transcript card calls the same action instead of inlining its own copy.

The authorization segments are chat-scoped. Both surfaces render the shared `ToolAuthSeg` / `McpAuthSeg`, and both pass an `onClear` that fires before `onPick` / `onSave`: the hook first drops this chat's entry for that tool (`PUT … { scope: 'chat', chat: { native: { shell: null } } }`) and then writes the tapped mode, so the stored override always equals the tap and a stale chat value can never shadow the project's mode. `SettingsProject` passes no `onClear` — its writes go to the project file, where the written value *is* the default.

```jsx
h(ToolTree, {
  groups,
  onToggleGroup: handleToggleGroup,
  onToggleTool: handleToggleTool,
  onReloadServer: handleReloadServer, // without this the "…" control is inert
  collapsedByDefault: true,
  class: 'tool-popup__tree'
})
```
