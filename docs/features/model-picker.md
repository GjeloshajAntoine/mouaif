# Model picker

## Overview

The chat view's **model picker** is the popover that opens from the head's `Pick model` trigger. It is the single screen the user spends the most time in inside the chat view (every new chat needs a model, every switch costs a tap), so its empty / loading / active states need to read at a glance on a phone. This doc covers the picker's behavior, the three states (loaded, empty, ghost), and the mobile-first layout rules that govern it.

The picker code lives in [src/web/src/components/chat/modelPicker.js](../../src/web/src/components/chat/modelPicker.js). The head's trigger button and the popover shell are declared in [src/web/src/components/chat/Chat.jsx](../../src/web/src/components/chat/Chat.jsx). Styles are in [src/web/src/chat.css](../../src/web/src/chat.css) under the `chat-view__picker*` selectors.

## Usage

1. Tap the **model trigger** in the chat head (top-left area: `<modelId>` on top, `<providerId>` underneath, `▾` caret on the right).
2. The popover opens:
   - On phones (`max-width: 480px`) it expands to a near-full-screen sheet anchored to the top of the chat view.
   - On wider screens it floats below the head with `left: 6px; right: 6px`.
3. Type in the search input to filter by `id` or upstream `label` (case-insensitive substring).
4. Tap a provider chip (`All`, `openrouter`, `anthropic`, …) to scope the list. The chip's count is the unfiltered model count, so a chip showing `0` means that provider has no known models regardless of the current search.
5. Tap a row to pick. The head trigger label updates, the popover closes, and `PATCH /api/chats/:id` writes `{ providerId, modelId }`.
6. Tap the head's ↻ button (or the action inside the empty-state card) to pull the live catalog from every configured provider in parallel; the status line shows `refreshing models…` then `models: N` on success.

`Escape` closes the popover and returns focus to the trigger button. The picker is fully usable with a single tap; the row is a native `<button>` so a desktop keyboard user can also `Tab` between rows and press `Enter` to pick. (Arrow-key navigation across rows is a follow-up.)

## Behavior

- **Sections, one per provider.** The list is grouped by `provider` (alphabetical) and each section has a sticky header with the provider id and a count pill. Sorting inside a section is alphabetical by `id`.
- **Active selection is marked two ways.** The active row has an accent-soft background and a 3 px accent rail on its left edge, so the selection is identifiable even at the bottom of a long list. The accent rail is a `::before` pseudo so it doesn't shift the row's text when the `is-active` class toggles (the row's right padding compensates for the 2 px left-padding increase).
- **Ghost row.** If the chat references a `(providerId, modelId)` that is not in the live catalog and is hidden by the current filter, a virtual ghost row is added at the top of the active-provider section so the user can see what they had. Tapping the ghost row keeps the same `providerId / modelId` and re-saves it; the next /api/chats/:id roundtrip re-resolves the catalog and either confirms the row or marks it ghost again. The ghost row uses the warning color and the meta line reads `unavailable`.
- **Search is incremental.** Every keystroke in the search input re-renders the list; the filter chips and per-section counts stay stable (the counts ignore the search so a chip showing `342` still means `342` when the user has typed `gpt-3`).
- **Empty state is a card, not a line.** When the filtered list is empty the picker shows a centered card with an icon tile (search or gear, depending on the cause), a short title, a one-line body, and an inline action:
  - **No matches** for the current query → **Clear search** button. Resets the search input and re-renders.
  - **No providers configured** → **Open Settings** button. Closes the picker and navigates to `#/settings/providers`.
  - **No models yet / provider has no models** → **Refresh models** button. Calls the same `refreshAllProviders` the head's ↻ does; the card re-renders as soon as the response lands.
- **Loading state.** The picker's open-time fetch fires automatically when the chat loads (active provider first, then all providers in parallel). While the fetch is in flight the popover opens with the cached catalog; an empty first-time catalog renders the **No models yet** card instead of a bare "loading…" line, because the picker is a list of facts about providers and "no models yet" is the honest state — the refresh action is one tap away.
- **Refresh button states.** The head's ↻ button is `disabled` for the duration of the refresh call; the inline empty-state action gets the same `disabled` + `cursor: wait` treatment.
- **Close paths.** `×` button, outside click, `Escape` key, and a successful pick all close the popover. On close, focus returns to the trigger button. The search query and active filter chip are preserved across re-opens via `state.pickerFilter` (in-memory only; the user has to re-pick on a fresh tab).

## Implementation notes

- The data feeding the picker is the union of the per-provider live catalog (`GET /api/ai/models/live`) and the project-level models array (the legacy `models` field in `.mouaif.json`), deduped by `(provider, id)` with project entries winning. See `modelsForPicker()` in [src/web/src/components/chat/modelPicker.js](../../src/web/src/components/chat/modelPicker.js).
- `state._onRefreshAllProviders` is bound in [src/web/src/components/chat/useChatState.js](../../src/web/src/components/chat/useChatState.js) so the empty-state card can call the same refresh path as the head's ↻ button without re-implementing it.
- The empty-state card markup lives in `renderPickerEmpty()` in [src/web/src/components/chat/modelPicker.js](../../src/web/src/components/chat/modelPicker.js). The icon, title, body, and action are constructed imperatively (not via Preact JSX) to match the rest of the picker which is also imperative — the SSE hot path stays as cheap as a `textContent` assignment.
- The accent rail on the active row is a `::before` pseudo on `.chat-view__picker-row.is-active`. The right padding is reduced by 2 px on the active row so the row's text doesn't shift when the `is-active` class toggles. This matters on a phone where a small horizontal shift in a long row is enough to make the user wonder if their tap landed.
- Mobile-first: the popover is `position: fixed; top: calc(48px + var(--safe-top)); bottom: var(--model-picker-keyboard-inset, 0px);` at `max-width: 480px` so it fills the screen with the head still visible. While the search input is focused, `visualViewport` resize / scroll events update `--model-picker-keyboard-inset` on iOS so the sheet ends above the on-screen keyboard and the bottom rows remain selectable. Above 480 px it falls back to a floating popover anchored to the head (`position: absolute; top: calc(100% + 4px); left: 6px; right: 6px;`).
- Section header counts are a pill (1 px border, `--border` color, 999 px radius) instead of plain text so the count reads as a discrete chip, not part of the section title.

## Related

- [docs/features/chat-ui.md](./chat-ui.md) — overall chat view layout, head structure, and the model trigger placement.
- [docs/features/ai-client.md](./ai-client.md) — provider catalog source for the live picker data.
- [docs/features/auth.md](./auth.md) — provider credentials; the **No providers** empty-state points the user here.
- [docs/features/settings-ui.md](./settings-ui.md) — the Settings tab the empty-state "Open Settings" action navigates to.
