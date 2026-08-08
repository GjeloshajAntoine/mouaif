# Chat error surfacing

## Overview

AI requests can fail in the middle of a turn: the provider returns an HTTP error, the network drops, or a tool round crashes. Before this feature, a mid-turn failure was emitted only when *no* content had been produced yet, and it appeared only in the composer's transient status line — the chat itself showed a permanently stuck "streaming…" state with no explanation. Now every failure is emitted over SSE, rendered as an inline error bubble in the transcript, and persisted as a `system` message so it survives a reload.

## Usage

No configuration. When a turn fails you see a red-tinted bubble at the failure point in the conversation:

- The bubble carries the error code and message (e.g. `EUPSTREAM: Upstream 429 Too Many Requests — rate limit exceeded`).
- If the model produced partial output before failing, that partial output is persisted first as an assistant message, then the error bubble follows it — the transcript shows exactly what was produced before the failure.
- Reloading the chat re-renders the error bubble from the persisted transcript; the post-stream reconciliation never erases it.
- Client-side send failures (network down before the request reached the server, HTTP 4xx rejections such as `409 EALREADY_RUNNING`) render the same bubble locally.

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
