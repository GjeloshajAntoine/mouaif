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

- **`thinking.js`** (new): `thinkingDescriptorFor(state)` resolves the active model's descriptor from the live model cache; `thinkingOptionsFor(descriptor)` builds the option list; `syncThinkingSelect(refs, state)` rebuilds the `<select>` options and restores the stored selection.
- **`Chat.jsx`**: the `<select>` is rendered empty and populated by `syncThinkingSelect`; the custom input is shown for the `__custom__` sentinel.
- **`useChatState.js`**: seeds the live cache with project-model descriptors, calls `syncThinkingSelect` on load, on chat patch, and whenever live model data arrives (`state._onLiveModels` hook, fired by the model picker's refresh paths).
- **`stream.js`**: passes `thinkingLevel` in the stream request body.
- **`chat-view.css`**: `.chat-view__thinking-select` and `.chat-view__thinking-custom` styles.

### Persistence

The thinking level is persisted on the chat record and survives reloads. If the stored value is not in the provider-reported option set (e.g. the model changed), it is kept via the custom input where available; for `toggle` models the dropdown shows "No thinking" without destroying the stored value.
