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
