# Chat error surfacing — implementation notes

> Agent-facing reference for [`docs/features/chat-error-surfacing.md`](../../features/chat-error-surfacing.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### Server (`src/index.js`, `handleChatStream`)

- The final `if (!result.ok)` branch no longer guards on `!assistantContent && !assistantReasoning`; the `error` SSE event is **always** emitted for a failed turn.
- Partial `assistantContent` / `assistantReasoning` accumulated before the failure is persisted as a normal assistant message before the error is persisted.
- `persistStreamError(err)` appends a `{ role: 'system', content }` message via `messages.appendMessage`, formatted by `formatStreamError(err)` (code + message + first line of upstream detail, capped at 300 chars — provider error bodies can be full HTML pages). Persisting is best-effort: a read-only transcript must not mask the original error.
- The `catch (streamErr)` path (a throw out of the streaming layer) persists and emits an `EINTERNAL` error the same way.

### Client (`frontend/src/components/chat/`)

- `transcript.js` exports `appendErrorCard(message, refs, state)`: renders a `.chat-msg--system.is-error` bubble (plain `textContent` — provider error bodies may carry markup) and mirrors the message into `state.messages` so a signature-based reconciliation does not wipe it before the server copy arrives.
- `stream.js` renders the SSE `error` event with `appendErrorCard` and shortens the status line to `error: CODE message`. Send-time failures (`fetch` throw, non-OK HTTP response) render the same bubble instead of a fake `[error: …]` assistant message.
- Styling lives in `frontend/src/components.css` (`.chat-msg--system.is-error`) using the `--danger` / `--danger-soft` design tokens.

### Upstream history

`messages.reconstructUpstreamHistory` passes `system` messages through as ordinary system turns, so a persisted error line is sent back to the provider on the next turn. That is intentional: it gives the model the failure context (e.g. "the previous attempt was rate-limited") instead of a silent gap.

Send preparation is guarded separately from the streaming request. Both network exceptions and rejected persistence responses reset the running state without adding an optimistic transcript row. The textarea and attachment picker are cleared only after preparation succeeds.
