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
  - **Anthropic** sends `max_tokens` (Anthropic's name for the output cap). When a thinking budget is set on an older Claude model, `max_tokens` is raised to at least `budget + 4096` so the answer still has room after the thinking.
- **Validation.** Only a positive all-numeric string is honoured. Empty, non-numeric, or `<= 0` input means **no override** — the field is not sent and the provider default applies. Invalid input is silently discarded rather than persisted.
- **Anthropic default.** With no override, a streamed Anthropic request asks for `min(64000, model ceiling)` output tokens (8192 for Claude 3.5, 32000 for Opus 4 / 4.1, 64000 for current models); a non-streamed one asks for at most 16000. An id that is not a Claude model (an Anthropic-compatible proxy) gets 16000. The old default of 1024 cut most replies short.
- **Truncation is shown.** A reply that ends at the cap (`length`, `max_tokens`, Gemini's `MAX_TOKENS`) gets a ⚠ note in the transcript after it, saved like a turn error so it survives a reload and is never sent to the model. Filtered (`content_filter`, `SAFETY`, …), refused (`refusal`) and paused (`pause_turn`) replies get the same kind of note. A round cut off while writing a tool call fails with `ETRUNCATED` instead of running the tool with half-written arguments.

## Related

- [docs/features/model-picker.md](./model-picker.md) — the popover this field lives in.
- [docs/features/thinking-level.md](./thinking-level.md) — the sibling per-chat field whose plumbing `maxOutputTokens` mirrors.
