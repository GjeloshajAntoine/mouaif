# Chat UI — Preact + Vite mobile shell — implementation notes

> Agent-facing reference for [`docs/features/chat-ui.md`](../../features/chat-ui.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## HTTP (chat-aware)

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/chats/:id/messages?projectDir=<abs>` | — | `{ messages: [{ role, content, ts }] }` (422 on corrupt file) |
| POST   | `/api/chats/:id/messages` | `{ projectDir, role, content }` | `{ message }` (201) |
| DELETE | `/api/chats/:id/messages?projectDir=<abs>` | — | `{ ok: true, removed }` |
| POST   | `/api/chats/:id/messages/stream` | `{ projectDir, modelId, providerId?, content }` | **SSE stream** of `message` / `done` / `error` events; `providerId` resolves live-catalog models that are not stored in the optional project `models` array. |
| GET    | `/api/ai/models?projectDir=<abs>` | — | `{ models: [{ id, provider, label, auth }], providers: [..] }` — project-level model list (the `models` array in `.mouaif.json`). |
| GET    | `/api/ai/models/providers` | — | `{ providers: [{ id }] }` — configured app-level provider connections, with no credentials. |
| GET    | `/api/ai/models/live?provider=<id>` | — | `{ models: [{ id, label, contextWindow? }], fetchedAt, cached }` — live catalog from the upstream `/models` endpoint (or curated for Anthropic/Copilot). Cached 1h per `provider:credHash`. 400 on unknown provider; 502 `{ error, code: 'EUPSTREAM' }` on upstream failure; 8 s `AbortController` timeout. |

## Build and Dev

```bash
npm install         # prepare builds frontend/dist/ when it is stale
node bin/mouaif.js serve
```

`npm run build:web` still exists for an explicit rebuild (and is what `prepack`
and `prepublishOnly` call). The install path no longer needs it — see
[docs/agent/features/cli-commands.md](./cli-commands.md).

Dev with HMR:
```bash
npm run dev:web      # vite dev server on :5173 (not used by the Node server)
```

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

Call and result cards are keyed by one shared `data-tool-id`. Because not every
provider echoes a tool-call id — and a few internal call sites pass `id: null` on
purpose (a subagent that failed to start, a tool or MCP error result) — the
call card mints an id and parks it in `refs._anonToolCalls`;
`appendToolResultCard` adopts a parked id when the result carries none of its
own, preferring the entry whose tool name matches, and never reusing an entry
whose card has left the tree. Both sides previously minted an independent random
id in that case, so the result could never find the call card: the transcript
grew a duplicate result card and the call card stayed on “Waiting for
results…” forever. `scripts/test-tool-call-id-matching.js` covers this.

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

Image attachments are also persisted as a chat-level draft. `chat_store`
carries a `draft_attachments` column (JSON array), written alongside the text
`draft` field. The composer restores it on reopen and clears it after a send.

- Build: [frontend/vite.config.js](../../frontend/vite.config.js), `frontend/index.html`, [frontend/src/main.jsx](../../frontend/src/main.jsx), [frontend/src/style.css](../../frontend/src/style.css), [frontend/src/virtual-list.js](../../frontend/src/virtual-list.js). Vite emits hashed assets under `frontend/dist/assets/`.
- Server: [src/index.js](../../src/index.js) → `handleChats()` handles `/api/chats/:id/messages[/:action]` and delegates streaming to `handleChatStream()`. The static `/` route prefers `frontend/dist/`, falls back to `frontend/` for dev.
- Messages: per-chat storage in SQLite database `~/.mouaif/store.sqlite`.
- Trace: [src/trace.js](../../src/trace.js) — per-chat NDJSON writer (`<projectDir>/.mouaif/traces/<chatId>.ndjson`), no-op when `chat.trace` is false.
- Bottom nav: Projects / Inspector / Settings.
