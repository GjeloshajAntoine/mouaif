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

- `closeLive(state, projectDir, chatId)` requires the caller's own
  `projectDir`/`chatId`, captured by the effect closure that owns the
  subscription. `state` is a stable ref object whose `props` field is
  reassigned during every render, so a chat-switch cleanup would otherwise
  resolve the key from the chat the user moved *to* and leak the previous
  chat's socket. `dispatchLiveEvent` and `handleLiveRunEnd` also verify the
  subscription key against `state.props` before touching `refs`, so a
  socket that is still draining after a switch cannot paint into the
  transcript that replaced it (notably `removeOverlayCards`, which would
  otherwise wipe the new chat's pending authorization card).
