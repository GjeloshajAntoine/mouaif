# Max output tokens — implementation notes

> Agent-facing reference for [`docs/features/max-output-tokens.md`](../../features/max-output-tokens.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- **Chat record.** `maxOutputTokens` is a string column `max_output_tokens` on `chat_store` (empty = no override). It mirrors the existing `thinkingLevel` plumbing end to end:
  - [src/chatdb.js](../../../src/chatdb.js) maps the column to `chat.maxOutputTokens`.
  - [src/chats.js](../../../src/chats.js) normalizes the field in `normalizeChat`, `createChat`, and both `updateChat` (DB and JSON project) paths.
  - [src/settings.js](../../../src/settings.js) ships migration `2026-07-28-add-max-output-tokens` that `ALTER TABLE`s existing databases.
- **Stream pass-through.** [src/server-handlers-chats.js](../../../src/server-handlers-chats.js) reads `maxOutputTokens` from the request body (falling back to the chat record) and passes it to `ai.streamChat`. [src/ai-stream.js](../../../src/ai-stream.js) copies it onto `model.maxOutputTokens`, where the request builders read it.
- **Request builders** in [src/ai-endpoints.js](../../../src/ai-endpoints.js):
  - `buildOpenAIRequest` adds `max_completion_tokens` when set.
  - `buildAnthropicRequest` uses it for `max_tokens`, keeping the `budget + 256` thinking override.
- **Frontend.** The input lives in [frontend/src/components/chat/Chat.jsx](../../../frontend/src/components/chat/Chat.jsx) inside the picker popover, seeded on open from the `onPickerOpen` hook in [frontend/src/components/chat/useChatState.js](../../../frontend/src/components/chat/useChatState.js) and saved via `state._updateChat({ maxOutputTokens })`. The current value is tracked in [frontend/src/components/chat/useChatState.js](../../../frontend/src/components/chat/useChatState.js) on `state.maxOutputTokens` and sent with each turn by [frontend/src/components/chat/stream.js](../../../frontend/src/components/chat/stream.js).
- **Mobile-first.** The input is a full-width number field in its own row under the search bar in the picker sheet, sized to a `--tap` touch target. It can be reached without leaving the popover.
- **Mobile tap reliability.** The picker's scroll-lock (the `touchmove` handler in [frontend/src/components/ModelPickerField.jsx](../../../frontend/src/components/ModelPickerField.jsx)) attaches a non-passive `touchmove` listener to the whole sheet that `preventDefault()`s non-list gestures so the sheet stays still while the list scrolls. A real finger "tap" carries a few px of `touchmove` jitter, and that `preventDefault()` before the synthetic `click` fired would swallow the tap — the field would never focus and the keyboard would never open on a phone. The handler now skips `preventDefault()` when the gesture target is a form control (`input`, `textarea`, `select`, `button`), so the max-output field (and the search input on re-taps) focus normally. The search field was never hit because it is auto-focused when the picker opens.
