# Max output tokens

## Overview

A per-chat **max output tokens** override in the model picker popover. It lets you cap how many tokens a model may generate per turn, instead of relying on each provider's default (which may be very large for reasoning models). It is stored on the chat record, so it travels with the chat and applies to whichever model the chat uses. Leaving the field blank uses the provider default.

## Usage

1. Tap the **model trigger** in the chat head to open the model picker.
2. Below the search input, in the same popover, there is a **Max output tokens** number input.
3. Type a positive integer (e.g. `2048`) to set the cap for this chat, or clear it to fall back to the provider default.
4. Press `Enter` or blur the field to save. The value is written with `PATCH /api/chats/:id` (`{ maxOutputTokens }`) and applies to the next turn.

The value is per chat, not per model: switching models keeps the same cap (or you can clear it for a specific chat). Blank means "no override — use the provider default."

## Behavior

- **How the cap is sent.** On each streamed turn the frontend includes `maxOutputTokens` in the `POST /api/chats/:id/messages/stream` body. It rides the chat record even when the field is left untouched, so a value set once keeps applying to later turns and across reloads.
- **Provider mapping.** The single value is translated differently per provider family:
  - **OpenAI-compatible providers** (`openai-compatible`, `openrouter`, `azure`, `mistral`, `groq`, `deepseek`, `github-copilot`) send `max_completion_tokens`.
  - **Anthropic** sends `max_tokens` (Anthropic's name for the output cap). When a thinking budget is set, Anthropic still bumps `max_tokens` to `budget + 256` so the thinking budget fits inside the cap.
- **Validation.** Only a positive all-numeric string is honoured. Empty, non-numeric, or `<= 0` input means **no override** — the field is not sent and the provider default applies. Invalid input is silently discarded rather than persisted.
- **Default remains 1024** when no override is set on the Anthropic path, matching prior behaviour.

## Implementation notes

- **Chat record.** `maxOutputTokens` is a string column `max_output_tokens` on `chat_store` (empty = no override). It mirrors the existing `thinkingLevel` plumbing end to end:
  - [src/chatdb.js](../../src/chatdb.js) maps the column to `chat.maxOutputTokens`.
  - [src/chats.js](../../src/chats.js) normalizes the field in `normalizeChat`, `createChat`, and both `updateChat` (DB and JSON project) paths.
  - [src/settings.js](../../src/settings.js) ships migration `2026-07-28-add-max-output-tokens` that `ALTER TABLE`s existing databases.
- **Stream pass-through.** [src/server-handlers-chats.js](../../src/server-handlers-chats.js) reads `maxOutputTokens` from the request body (falling back to the chat record) and passes it to `ai.streamChat`. [src/ai-stream.js](../../src/ai-stream.js) copies it onto `model.maxOutputTokens`, where the request builders read it.
- **Request builders** in [src/ai-endpoints.js](../../src/ai-endpoints.js):
  - `buildOpenAIRequest` adds `max_completion_tokens` when set.
  - `buildAnthropicRequest` uses it for `max_tokens`, keeping the `budget + 256` thinking override.
- **Frontend.** The input lives in [frontend/src/components/chat/Chat.jsx](../../frontend/src/components/chat/Chat.jsx) inside the picker popover, seeded on open from [frontend/src/components/chat/modelPicker.js](../../frontend/src/components/chat/modelPicker.js) and saved via `state._updateChat({ maxOutputTokens })`. The current value is tracked in [frontend/src/components/chat/useChatState.js](../../frontend/src/components/chat/useChatState.js) on `state.maxOutputTokens` and sent with each turn by [frontend/src/components/chat/stream.js](../../frontend/src/components/chat/stream.js).
- **Mobile-first.** The input is a full-width number field in its own row under the search bar in the picker sheet, sized to a `--tap` touch target. It can be reached without leaving the popover.
- **Mobile tap reliability.** The picker's scroll-lock (`bindPickerScrollLock` in `modelPicker.js`) attaches a non-passive `touchmove` listener to the whole sheet that `preventDefault()`s non-list gestures so the sheet stays still while the list scrolls. A real finger "tap" carries a few px of `touchmove` jitter, and that `preventDefault()` before the synthetic `click` fired would swallow the tap — the field would never focus and the keyboard would never open on a phone. The handler now skips `preventDefault()` when the gesture target is a form control (`input`, `textarea`, `select`, `button`), so the max-output field (and the search input on re-taps) focus normally. The search field was never hit because it is auto-focused when the picker opens.

## Related

- [docs/features/model-picker.md](./model-picker.md) — the popover this field lives in.
- [docs/features/thinking-level.md](./thinking-level.md) — the sibling per-chat field whose plumbing `maxOutputTokens` mirrors.