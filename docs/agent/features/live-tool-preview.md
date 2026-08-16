# Live tool preview on returning to a running chat — implementation notes

> Agent-facing reference for [`docs/features/live-tool-preview.md`](../../features/live-tool-preview.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Files:
  - `src/live-chat.js` — the per-chat live-replay registry: `ensureLiveChat`, `pushLive`, `pruneLive`, `addSubscriber`, `finishLiveChat`; assigns monotonic `liveSeq` values and filters replay by `fromLiveSeq`.
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
