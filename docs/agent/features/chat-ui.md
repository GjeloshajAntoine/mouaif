# Chat UI — Preact + Vite mobile shell — implementation notes

> Agent-facing reference for [`docs/features/chat-ui.md`](../../features/chat-ui.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

When a chat page is reloaded while an agent run is still active on the
server, the replacement page polls the persisted transcript once per second.
New assistant segments, tool calls, and tool results therefore appear as they
are saved, without requiring another manual reload. A tab that owns the live
SSE stream does not poll over its in-progress rendering. The server-side run is
not cancelled just because the browser's SSE connection closes; stream writes
are best-effort and the persisted transcript remains authoritative.

Each model tool round-trip has an explicit `assistant_turn_end` SSE boundary.
Text emitted before a tool call is finalized in its own assistant bubble, the
tool call and result follow it, and subsequent model text starts a new bubble.
Blank assistant boundaries are skipped, so a tool-only round does not create an
empty chat bubble. This preserves the real assistant → tool → assistant order
both live and after reopening the chat.

Tool-card rendering is isolated from the network reader. A malformed or
unsupported tool payload can fail to render without aborting the remaining SSE
stream or suppressing the assistant response that follows the tool result.

When authorization is required, the authorization card is emitted before the
tool-call card. The call appears as “running” only after approval; denial or a
disabled tool still produces an adjacent call/result pair. This avoids leaving
a misleading permanent “running” card while execution is waiting for input.

After a streamed exchange completes, the browser reconciles the rendered turn
with the server transcript. The persisted transcript is authoritative, so a
missed or failed live DOM update cannot leave the screen ending on a tool card
when the post-tool assistant message was successfully stored.

A message sent while the chat is already running is never persisted by the
server (`409 EALREADY_RUNNING`). The send path in
[frontend/src/components/chat/stream.js](../../frontend/src/components/chat/stream.js)
treats that status specially: it drops the optimistic bubble, restores the
composer (text, attachments, and the debounced draft), and shows a busy status
instead of an error card, so the same-disk poll cannot wipe the message.

- Build: [frontend/vite.config.js](../../frontend/vite.config.js), `frontend/index.html`, [frontend/src/main.jsx](../../frontend/src/main.jsx), [frontend/src/style.css](../../frontend/src/style.css), [frontend/src/virtual-list.js](../../frontend/src/virtual-list.js). Vite emits hashed assets under `frontend/dist/assets/`. Current production output is about 69 KB JS + 26 KB CSS, about 22 KB + 5 KB gzipped.
- Server: [src/index.js](../../src/index.js) → `handleChats()` now also handles `/api/chats/:id/messages[/:action]` and delegates the stream to `handleChatStream()`. The static `/` route prefers `frontend/dist/`, falls back to `frontend/` for dev.
- Messages: [src/messages.js](../../src/messages.js) — per-chat file `<projectDir>/.mouaif.messages.<chatId>.json`. Robust read (drops malformed entries), throws `MOUAIF_PROJECT_PARSE_ERROR` (422) only if the file itself is corrupt.
- Trace: [src/trace.js](../../src/trace.js) — per-chat NDJSON writer, no-op when `chat.trace` is false or the directory can't be created.
- Bottom nav: Projects / Inspector / Settings. Settings contains provider connections, provider authentication, and the raw project-settings editor.
- Dropped (intentionally): the previous `AI test` panel and the `Virtual list demo`. They were dev-time affordances; the chat view replaces the AI test, while the Inspector now consumes the virtual-list primitive.
