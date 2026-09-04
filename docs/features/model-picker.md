# Model picker

## Overview

The **model picker** is the popover that opens from the header's model trigger. It allows you to search, filter by provider, and switch active models effortlessly across both phone and desktop screens.

The same model picker is also used in subagent authorization cards and agent persona editors. Those locations use the same compact, single-line trigger styling as chat while retaining a mobile-sized touch target, and they render no extra descriptive text — the dropdown reads exactly like the chat header's picker.

## Usage

1. Tap the **model trigger** in the chat header (showing the current model and provider).
2. The model picker opens:
   - On phones, it expands to a full-width sheet anchored to the viewport.
   - On wider screens, it floats comfortably below the header.
3. Type in the search input to filter models by name or slug.
4. Tap a provider chip (`All`, `Anthropic`, `OpenRouter`, `OpenAI`, etc.) to scope the list to a specific provider.
5. Tap any row to select the model for the current conversation.
6. Tap the ↻ refresh button to fetch live model catalogs directly from connected providers. This bypasses the server's 1-hour cache (via a `_bust` cache-buster) so it re-hits the upstream rather than returning the previously fetched list.

Pressing `Escape` or tapping outside closes the popover.

## Behavior

- **Bookmarks & Recents** — pinned and recently used models stay easily accessible at the top of the picker.
- **Unavailable / Custom models** — if a model is currently offline or custom-configured, it renders as a distinct selection so you can see what is currently set and switch when ready.
- **Fast search** — filters instantly across all connected provider catalogs.
- **Instantly opens** — tapping the trigger shows the sheet immediately with whatever models are already loaded (project slugs + any live catalog already fetched). The server-backed Recent section refreshes in the background and lands in one re-render once the request resolves, so opening never waits on a network or DB round-trip.
- **Empty-state actions** — **Refresh models** remains the primary action when no models match a search or a provider has no models (where catalog refresh is supported). A non-empty search also offers a separate **Clear search** action: it clears only the text, keeps the selected provider, returns focus to search, and makes no network request. Whitespace-only text is not treated as a search.
- **Refresh without losing your place** — both the header and empty-state refresh actions fetch fresh catalogs, even with no search matches. Refresh keeps the sheet open, retains the query and provider filter, and does not clear the existing catalog while loading. Pointer activation keeps an already-focused search input focused; completion does not steal focus or reopen a dismissed keyboard. Duplicate refreshes are blocked while loading; provider failures and rejected requests show a retryable inline error. Refresh feedback stays inside the picker: it never changes the bottom composer status, which would resize and re-pin the transcript behind the sheet.
- **Native mobile gestures** — swipe the model list vertically or the provider chips horizontally. Slight finger movement on short-list rows no longer cancels selection. Keyboard opening, dismissal, and rotation resize the sheet to the visible viewport.

## Implementation notes

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

## Related

- [Model bookmarks](./model-bookmarks.md) — pinned and recent models.
- [AI client](./ai-client.md) — connected AI providers and endpoints.
- [Thinking Level](./thinking-level.md) — configuring reasoning effort for thinking models.
- [Max output tokens](./max-output-tokens.md) — token limits configurable in the picker.
