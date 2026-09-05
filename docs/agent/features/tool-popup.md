# Tool popup — implementation notes

> Agent-facing reference for [`docs/features/tool-popup.md`](../../features/tool-popup.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

The chat keeps tool catalogs, MCP servers, agent files, skills, and authorization data in refs because the transcript renderer also consumes them imperatively. After the initial chat load populates those refs, a lightweight render stamp refreshes the popup props so opening it cannot show a stale “No tools available” state.

- **File:** `frontend/src/components/chat/ToolPopup.jsx` — Preact component with two states (closed trigger button, open popup).
- **CSS:** `frontend/src/chat-composer.css` (`.tool-popup*` classes under the *Tool popup* section).
- Reuses the existing `ToolTree` Preact component from `frontend/src/components/ToolTree.jsx` and the `buildToolGroups` helper.
- Auth segments reuse the same `.seg` / `.seg__item` / `.seg__pill` classes from `frontend/src/settings.css`, with compact overrides scoped under `.tool-popup`.
- Outside-click and Escape-key close the popup.
- **Positioning:** the popup opens *downward* from the trigger (`top` anchored to the chat header bottom), because the trigger sits in the chat head row near the top of the viewport — matching the model picker and chat switcher popovers in the same row. It is capped at `min(380px, 100vw - 20px)` wide and `min(60dvh, 400px)` tall with a scrollable body.
- **Top layer, non-modal:** the popup element is a native `popover` (`popover="manual"`) opened with `showPopover()`. This puts it on the browser's top layer — above the transcript's GPU-composited scroll tiles, which ignore z-index and DOM order — *without* dimming the page or making the background inert the way a `<dialog>` opened with `showModal()` does. The rest of the chat stays visible and interactive while the popup is open. `popupRef` calls `showPopover()`/`hidePopover()` in a `useLayoutEffect` keyed on `open`.
- **Mobile (< 480 px):** the popup stays a compact popover instead of expanding into a full-screen sheet. Its width is capped to the viewport, and its scrollable height is capped to the measured space between the chat header bottom and the visual viewport bottom so it cannot overflow downward past the composer and tab bar.
