# Add Inspector entries to a chat — implementation notes

> Agent-facing reference for [`docs/features/inspector-add-to-chat.md`](../../features/inspector-add-to-chat.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- `frontend/src/components/inspector/entryText.js` — `buildEntryText(item, context)`, a pure function kept out of the component so the draft formatting is unit-testable without a DOM. It never throws on a partial entry.
- `frontend/src/components/inspector/DetailSheet.jsx` — renders the button in a `.inspector__sheet-head-actions` row. The class is deliberately not `inspector__sheet-actions`, which is the Styles edit sheet's footer and carries `min-width: 96px` / `justify-content: flex-end`.
- `frontend/src/components/Inspector.jsx` — `addDetailItemToChat()` builds the payload (defaulting to `activeProject()`) and opens the shared `DraftCraftSheet`; the entry stays in `detailItem` so cancelling returns to the same sheet.
- `frontend/src/components/DraftCraftSheet.jsx` — the project/chat picker is reused unchanged; its subtitle is overridable through `payload.description` so the Inspector does not have to teach the component about a new source.
- The sheet header is a flex row: the title ellipsizes and the two buttons (`min-height: var(--tap)`, i.e. 44 px) never shrink, so both stay tappable at 360 px.
- CSS lives in `frontend/src/inspector-sheets.css`; the `@import` order in `frontend/src/inspector.css` is the cascade and was not changed.
