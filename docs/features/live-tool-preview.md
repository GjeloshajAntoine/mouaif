# Live tool preview on returning to a running chat

## Overview

When a chat is running, the transient tool streams — shell stdout/stderr (`shell_output`), nested subagent activity (`subagent_event`), progress updates (`progress_update`), and paused-run prompts (`authorization_required`, `ask_user_required`) — are buffered per chat on the server and replayed to any follower client in real time. A second tab, or a page that returns to / reopens a still-running chat, renders that live content and approval UI instead of waiting for the slower pending-authorization poll or the final settled transcript.

## Background

Tool **results** (`tool_result`) are persisted to the transcript, but the *live* content that fills the stream while a command runs is only ever emitted over the streaming chat's own SSE socket. Authorization and ask-user prompts are similarly live overlay cards rather than transcript rows. A follower — another tab, or a page whose SSE socket was lost or never joined the run — had no way to receive them. The transcript reconcile poll and `/api/tools/authorization/pending` would eventually catch up, but until then shell cards showed a static "Waiting for results…" placeholder, subagent/progress cards showed nothing, and approval prompts could feel slower in the UI than in push notifications.

## Usage

No user action required, and nothing changes for the streaming chat itself (it already renders live output via its own socket). The benefit shows up in two scenarios:

- **A second tab/device** opens the same running chat: its shell/subagent/progress cards now fill in live.
- **Returning to a chat** that is still running (you navigated away mid-run, or the page's stream socket dropped): the transcript renders the persisted tool-call rows, live replay back-fills their output, and any waiting authorization / ask-user card appears as soon as the live replay subscribes.

## Behavior

- While a chat has an in-flight run, the server keeps a per-chat live buffer holding only the **transient** events — exactly the ones never persisted on their own.
- A follower subscribes via `GET /api/chats/:id/live` (SSE). It immediately receives the buffered events for the in-flight run, then continues to receive new ones as they occur.
- Each event is routed into the same handler the streaming chat uses: `shell_output` fills the matching shell card's live `<pre>`, `subagent_event` fills the nested subagent card, `progress_update` creates/updates a progress card, and `authorization_required` / `ask_user_required` mount the same overlay cards as the owner stream.
- When a tool's result is persisted (`tool_result`), that tool's buffered stream is dropped, so a late subscriber never re-draws content the result card already rendered. Authorization and ask-user prompts are also pruned when the user answers `/api/tools/authorization/decision`, and followers receive `authorization_resolved` to remove stale replayed cards. Progress updates are never persisted, so they survive until the run ends.
- When the run finishes, the follower's SSE closes with a `run_end` event. The client then lets its ordinary reconcile poll settle the busy state.
- Subscribing to a chat that is **not** running returns `404` (JSON) — a client must never hold a dead live socket.

## Implementation notes

- Files:
  - `src/live-chat.js` — the per-chat live-replay registry: `ensureLiveChat`, `pushLive`, `pruneLive`, `addSubscriber`, `finishLiveChat`.
  - `src/server-shared.js` — exports the module (`liveChat`).
  - `src/server-handlers-chats.js` — the `/api/chats/:id/live` route; `handleChatStream` calls `ensureLiveChat` at run start, `pushLive`/`pruneLive` inside `emit`, and `finishLiveChat` at every exit.
  - `frontend/src/components/chat/live.js` — the client subscription (`subscribeLive`, `closeLive`) that dispatches events to the existing transcript handlers.
  - `frontend/src/components/chat/useChatState.js` and `stream.js` — open the subscription when a chat loads/runs and closes it on unmount.

- The `emit` hook in `handleChatStream` fans the transient events to followers:

```js
if (name === 'shell_output' || name === 'subagent_event' || name === 'progress_update'
|| name === 'authorization_required' || name === 'ask_user_required') {
  liveChat.pushLive(runKey, name, data);
} else if (name === 'tool_result') {
  liveChat.pruneLive(runKey, data && data.id);
}
```

- The client subscription is deduped per `(projectDir, chatId)` and reserves its map entry synchronously, so a load plus a reconcile tick can never open two sockets.

## Related

- [Chat UI](chat-ui.md)
- [Streaming assistant text](chat-streaming-performance.md)
- [Chat load performance](chat-load-performance.md)
- [Run settle latch](run-settle-latch.md)
- [Progress tool](progress-tool.md)
- Source: `src/live-chat.js`, `frontend/src/components/chat/live.js`