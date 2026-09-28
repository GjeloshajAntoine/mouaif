# Thinking Level — implementation notes

> Agent-facing reference for [`docs/features/thinking-level.md`](../../features/thinking-level.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### Server side

- **Database**: `chat_store.thinking_level TEXT DEFAULT ''` column on the `chat_store` table.
- **Chat record**: `thinkingLevel` is serialized/deserialized in `src/chatdb.js` (DB) and `src/chats.js` (JSON file).
- **PATCH**: `thinkingLevel` can be set via `PATCH /api/chats/:id` with `{ thinkingLevel: "medium" }`.
- **Stream**: `POST /api/chats/:id/messages/stream` accepts an optional `thinkingLevel` field, which is passed to `ai.streamChat()` as `thinkingLevel`.
- **`GET /api/ai/models`**: attaches the provider-level `thinkingDescriptor` (Ollama's `toggle`) to each project model; a user-set `thinking` on the model record always wins.
- **`GET /api/ai/models/live`**: per-model `thinking` descriptors ride along with the live catalog (OpenRouter `supported_parameters`, Anthropic/Copilot curated catalogs, Gemini id inference).

### AI request builders

In `src/ai.js`:

- `buildOpenAIRequest` — passes any non-empty `model.thinkingLevel` verbatim as `body.reasoning_effort`. The valid set is provider-defined, so there is no client-side whitelist to lag new upstream values.
- `buildAnthropicRequest` — derives a `budget_tokens` number from the thinking level string and sets `body.thinking = { type: 'enabled', budget_tokens }`. Low=2048, Medium=8192, High=16384. Custom values are parsed via `parseInt` and capped at 100000. `max_tokens` is raised to at least `budget_tokens + 256`.
- `buildGeminiRequest` — maps presets/custom numbers to `generationConfig.thinkingConfig.thinkingBudget`.
- `buildOllamaRequest` — any non-empty thinking level sets `body.think = true`.

### Frontend

- **`thinking.js`**: pure option/descriptor shaping — `thinkingDescriptorFor(state)`, `thinkingOptionsFor(descriptor)`, `thinkingOptionsForSelect(descriptor)` (the sentinel-free list the `<select>` consumers use), `effectiveThinkingLevel(stored)` (what actually goes on the wire) and `thinkingLabelFor(options, value)`.
- **`ThinkingPicker.jsx`** (new): the control. A `dialog` opened with `showModal()` so it sits in the top layer — no clipping or transformed ancestor can cut it off, and the background goes inert. It reuses ModelPickerField's visual-viewport variables (`--model-picker-viewport-height` / `-top`) so the phone sheet ends above the keyboard. Nothing outside a render writes its DOM: the custom field's visibility is derived from the selected value.
- **`Chat.jsx`**: renders `ThinkingPicker` with the chat's `thinkingLevel` and the resolved descriptor. A record holding the legacy `__custom__` sentinel is normalized to `''` at this boundary.
- **`useChatState.js`**: holds no thinking DOM refs and never calls a rebuild. Both head controls are declarative, so `updateChatBound` merely fires `state._onChatChanged()` and `_onLiveModels` refreshes the picker snapshot.
- **`stream.js`**: sends `effectiveThinkingLevel(state)`; imports it from `thinking.js` rather than reading a DOM input.
- **`chat-view.css`**: `.thinking-picker*` styles (trigger, panel, rows, custom field, phone sheet).
- **`stream.js`**: sends `effectiveThinkingLevel(state.thinkingLevel)`, imported from `thinking.js` rather than read from a DOM input.

### Why it is declarative

The control used to be a bare `<select>` plus a `hidden` `<input>` that `syncThinkingSelect()` rebuilt by hand outside Preact's render cycle. Two bugs came from that, both fixed by removing the imperative path:

1. A background model-catalog fetch called `syncThinkingSelect`, resetting `hidden = true` on the input — the field vanished mid-entry and the `focus()` in the same tick fired on a `display:none` element, so no keyboard opened.
2. The input's own `onBlur` hid it. A blur is not a dismissal — tapping the composer, the keyboard opening and the closing picker all fire one — so "Custom…" flashed and vanished.

Two further races are handled in the component and pinned by the test: a blur caused by tapping another row must not commit (the row's own choice would race it), and `choose()` clears the draft *synchronously* through a ref before `close()` refocuses the trigger, because that refocus blurs the input on the next tick.

`scripts/test-thinking-custom-input.js` covers the option shaping, the sentinel never reaching the wire, and — as a shape guard — that `ThinkingPicker.jsx`/`Chat.jsx`/`useChatState.js` contain no imperative DOM writer.

### Persistence

The thinking level is persisted on the chat record and survives reloads. A stored value outside the provider-reported set (e.g. the model changed, or the user typed a number) is kept and shown in the custom field rather than being silently dropped; for `toggle` models the panel shows "No thinking" without destroying the stored value. The `__custom__` sentinel is never a stored value — a record that carries one is normalized to "No thinking" and `effectiveThinkingLevel()` refuses to put it on the wire.
