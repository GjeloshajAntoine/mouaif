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
6. Tap the ↻ refresh button to fetch live model catalogs directly from connected providers.

Pressing `Escape` or tapping outside closes the popover.

## Behavior

- **Bookmarks & Recents** — pinned and recently used models stay easily accessible at the top of the picker.
- **Unavailable / Custom models** — if a model is currently offline or custom-configured, it renders as a distinct selection so you can see what is currently set and switch when ready.
- **Fast search** — filters instantly across all connected provider catalogs.
- **Instantly opens** — tapping the trigger shows the sheet immediately with whatever models are already loaded (project slugs + any live catalog already fetched). The server-backed Recent section refreshes in the background and lands in one re-render once the request resolves, so opening never waits on a network or DB round-trip.
- **Contextual empty-state action** — the button in the empty card matches the cause. A search that matched nothing offers **Clear search** (drops the query and returns focus to the search box so the user can keep typing); it does not trigger a network refetch, which in the mobile sheet would blur the focused search, close the keyboard, reposition the sheet, and leave an unclickable layout. A provider with no models in the catalog offers **Refresh models**.
## Related

- [Model bookmarks](./model-bookmarks.md) — pinned and recent models.
- [AI client](./ai-client.md) — connected AI providers and endpoints.
- [Thinking Level](./thinking-level.md) — configuring reasoning effort for thinking models.
- [Max output tokens](./max-output-tokens.md) — token limits configurable in the picker.
