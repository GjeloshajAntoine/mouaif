# Model picker — implementation notes

> Agent-facing reference for [`docs/features/model-picker.md`](../../features/model-picker.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- The data feeding the picker is the union of the per-provider live catalog (`GET /api/ai/models/live`) and the project-level models array (the legacy `models` field in `.mouaif.json`), deduped by `(provider, id)` with project entries winning. See `modelsForPicker()` in [frontend/src/components/chat/modelPicker.js](../../../frontend/src/components/chat/modelPicker.js).
- `ModelPickerField` is props-driven for `models` and `value`; only transient interaction state (open/search/filter/refreshing) is local. [frontend/src/components/chat/useChatState.js](../../../frontend/src/components/chat/useChatState.js) supplies one atomic `picker` state object, while the imperative authorization-card host uses [frontend/src/components/AuthModelPicker.jsx](../../../frontend/src/components/AuthModelPicker.jsx) as the stateful adapter.
- `state._onRefreshAllProviders` is bound in [frontend/src/components/chat/useChatState.js](../../../frontend/src/components/chat/useChatState.js) so the empty-state card can call the same refresh path as the head's ↻ button without re-implementing it.
- The empty-state card markup lives in the shared component's `mp__empty` block; the chat-specific "Open Settings" / "Refresh models" / "Clear search" actions are driven through the `refresh` prop (bound to `refreshAllProviders`) and the search input's own state. The old imperative `renderPickerEmpty()` remains in [frontend/src/components/chat/modelPicker.js](../../../frontend/src/components/chat/modelPicker.js) for the non-shared helpers but the rendered list now comes from the Preact component.
- The accent rail on the active row is a `::before` pseudo on `.mp__row.is-active`. The right padding is reduced by 2 px on the active row so the row's text doesn't shift when the `is-active` class toggles. This matters on a phone where a small horizontal shift in a long row is enough to make the user wonder if their tap landed.
- Mobile-first: the chat variant (`.mp--chat`) makes its popover `position: fixed; top: calc(var(--model-picker-viewport-top, 0px) + 48px + var(--safe-top)); height: calc(var(--model-picker-viewport-height, 100dvh) - 48px - var(--safe-top));` at `max-width: 480px`. `--model-picker-viewport-height` is `visualViewport.height` and `--model-picker-viewport-top` is `visualViewport.offsetTop`, so the sheet bottom lands exactly on the visible bottom edge (the keyboard / browser chrome shrinks the visual viewport). The vars are re-measured on `focusin`/`focusout` (and `visualViewport` resize/scroll) inside the component's keyboard effect, so the sheet re-tightens when the search keyboard opens. When the keyboard opens (inset transitions 0 → positive), the list is re-anchored to its bottom so the last rows are reachable after the sheet shrinks. The `index.html` viewport meta uses `interactive-widget=resizes-content` so desktop Chrome resizes the layout viewport for the keyboard instead of overlaying it. The sheet uses `overflow: hidden` plus a touch scroll lock, and only the `mp__list` is allowed to pan vertically; the list carries only home-indicator bottom padding (no keyboard inset — the sheet's height already ends above the keys, so an inset would add a dead zone at the end of the scroll).
- The sheet must not have a transformed ancestor: flush views skip the view-enter animation (`.app__main--flush > section { animation: none; }` in [frontend/src/layout.css](../../../frontend/src/layout.css)), because a transform on the section turns it into a containing block and the `position: fixed` sheet is then laid out relative to it, pushing the sheet bottom above the real viewport bottom (the "goes too low" symptom).
- Section header counts are a pill (1 px border, `--border` color, 999 px radius) instead of plain text so the count reads as a discrete chip, not part of the section title.

Sheet variants in `frontend/src/components/ModelPickerField.jsx` use a native `dialog` opened with `showModal()`. The browser top layer keeps the picker out of clipping, transformed, and scrolling app ancestors and makes background controls inert while it is open. Close, Escape, and backdrop taps release the modal and restore trigger focus. Desktop positioning uses the trigger's viewport rectangle; phone landscape retains the viewport sheet layout.

The component updates the sheet's visual-viewport height and top offset before paint and on resize/scroll events. The sheet bottom remains at `visualViewport.offsetTop + visualViewport.height`; keyboard height is not subtracted a second time. Focus uses `preventScroll`, and Clear search focuses synchronously rather than in a later animation frame.

`frontend/src/chat-view.css` uses native scrolling and overscroll containment rather than cancelling `touchmove`. Mobile search and model-option inputs use a 1rem font to avoid small-input focus zoom. Viewport listeners and scheduled focus synchronization are cleaned up when the sheet closes.

### Regression checks

With debug Chrome available at `http://127.0.0.1:9222` (or `CDP_URL`), run:

```bash
node scripts/test-model-picker.cjs
node scripts/test-model-picker-chat.cjs
```

The component test checks touch gestures, focus, filters, errors, landscape, backdrop dismissal, and simulated visual-viewport changes. The ChatView integration test mounts the real app and full stylesheet with mocked requests: refresh success/failure must leave composer status, transcript geometry, and scroll offsets unchanged, including under transformed/clipped ancestors. Neither test modifies app data. Real iOS Safari/PWA keyboard animation still needs a device check.

The production refresh helper in `frontend/src/components/chat/modelPicker.js` returns `{ count, error }` to the picker through `useChatState.js`; it does not write chat status. Successful provider catalogs still update through the existing live-model callback, and failures retain their previous catalog.
