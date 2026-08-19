# Max output tokens

## Overview

A per-chat **max output tokens** override in the model picker's options panel. It lets you cap how many tokens a model may generate per turn, instead of relying on each provider's default (which may be very large for reasoning models). It is stored on the chat record, so it travels with the chat and applies to whichever model the chat uses. Leaving the field blank uses the provider default.

## Usage

1. Tap the **model trigger** in the chat head to open the model picker.
2. Tap the **Model options** gear button beside the search input.
3. Enter a positive integer (e.g. `2048`) in **Max output tokens**, or clear it to fall back to the provider default.
4. Press `Enter` or blur the field to save. The value is written with `PATCH /api/chats/:id` (`{ maxOutputTokens }`) and applies to the next turn.

The value is per chat, not per model: switching models keeps the same cap (or you can clear it for a specific chat). Blank means "no override — use the provider default."

## Behavior

- **How the cap is sent.** On each streamed turn the frontend includes `maxOutputTokens` in the `POST /api/chats/:id/messages/stream` body. It rides the chat record even when the field is left untouched, so a value set once keeps applying to later turns and across reloads.
- **Provider mapping.** The single value is translated differently per provider family:
  - **OpenAI-compatible providers** (`openai-compatible`, `openrouter`, `azure`, `mistral`, `groq`, `deepseek`, `github-copilot`) send `max_completion_tokens`.
  - **Anthropic** sends `max_tokens` (Anthropic's name for the output cap). When a thinking budget is set, Anthropic still bumps `max_tokens` to `budget + 256` so the thinking budget fits inside the cap.
- **Validation.** Only a positive all-numeric string is honoured. Empty, non-numeric, or `<= 0` input means **no override** — the field is not sent and the provider default applies. Invalid input is silently discarded rather than persisted.
- **Default remains 1024** when no override is set on the Anthropic path, matching prior behaviour.

## Related

- [docs/features/model-picker.md](./model-picker.md) — the popover this field lives in.
- [docs/features/thinking-level.md](./thinking-level.md) — the sibling per-chat field whose plumbing `maxOutputTokens` mirrors.
