# Model picker

## Overview

The **model picker** opens from the compact model dock above the chat composer. It keeps the active model and thinking level within thumb reach while leaving the chat header focused on navigation and usage.

The same searchable picker is also used in subagent authorization cards and agent persona editors.

## Usage

1. Tap the **model trigger** above the message composer (showing the current model and provider).
2. The model picker opens:
   - On phones, it expands upward as a full-width bottom sheet.
   - On wider screens, it floats above the model dock.
3. Type in the search input to filter models by name or slug.
4. Tap a provider chip (`All`, `Anthropic`, `OpenRouter`, `OpenAI`, etc.) to scope the list to a specific provider.
5. Tap any row to select the model for the current conversation.
6. Tap the ↻ refresh button to fetch live model catalogs directly from connected providers.

Pressing `Escape` or tapping outside closes the popover.

## Behavior

- **Bookmarks & Recents** — pinned and recently used models stay easily accessible at the top of the picker.
- **Unavailable / Custom models** — if a model is currently offline or custom-configured, it renders as a distinct selection so you can see what is currently set and switch when ready.
- **Fast search** — filters instantly across all connected provider catalogs.

## Related

- [Model bookmarks](./model-bookmarks.md) — pinned and recent models.
- [AI client](./ai-client.md) — connected AI providers and endpoints.
- [Thinking Level](./thinking-level.md) — configuring reasoning effort for thinking models.
- [Max output tokens](./max-output-tokens.md) — token limits configurable in the picker.
