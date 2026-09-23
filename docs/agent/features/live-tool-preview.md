# Live tool preview on returning to a running chat — implementation notes

> Agent-facing reference for [`docs/features/live-tool-preview.md`](../../features/live-tool-preview.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Files:
  - `src/live-chat.js` — the per-chat live-replay registry: `ensureLiveChat`, `setSegment`, `hasSubscribers`, `pushLive`, `pushTransient`, `pruneLive`, `addSubscriber`, `finishLiveChat`; assigns monotonic `liveSeq` values and filters replay by `fromLiveSeq`.
  - `src/server-shared.js` — exports the module (`liveChat`).
  - `src/server-handlers-chats.js` — the `/api/chats/:id/live` route; `handleChatStream` calls `ensureLiveChat` at run start, `pushLive`/`pushTransient`/`pruneLive`/`setSegment` inside `emit`, and `finishLiveChat` at every exit. Also holds `nextLiveMessageSeq` (the per-chat transcript-seq prediction) and `liveSeqByChat`.
  - `frontend/src/components/chat/live.js` — the client subscription (`subscribeLive`, `closeLive`) that dispatches events to the existing transcript handlers.
  - `frontend/src/components/chat/transcript.js` — the follower-specific DOM entry points `restoreLiveSegment`, `finalizeLiveSegment`, `clearLiveSegment`, plus `bufferPendingShellOutput`/`takePendingShellOutput` for early shell output.
  - `frontend/src/components/chat/useChatState.js` and `stream.js` — open the subscription when a chat loads/runs and close it on unmount; `useChatState` arms `watchingRun` and kicks the poll on load, and exposes `_drainOlderMessages`.

### Event classes on the follower stream

| Frame | Buffered? | Carries `liveSeq`? | Why |
| --- | --- | --- | --- |
| `shell_output`, `subagent_event`, `progress_update`, `authorization_required`, `ask_user_required` | yes | yes | A late subscriber needs transient tool activity that never reaches the persisted transcript on its own. |
| `message`, `reasoning` | no | no | One frame per token. Buffering would replay a whole turn on every reconnect and grow the buffer without bound. |
| `assistant_turn_end` | no | no | The segment is persisted immediately, so the transcript sync delivers it; the frame exists to hand over the row's `seq`. |
| `live_segment` | no | no | Sent once at subscribe time so a mid-turn joiner can paint the in-progress segment. |

`liveSeq` is allocated only for buffered events. A frame that is never stored must not advance the cursor, or a reconnect's `fromLiveSeq` would skip a buffered `shell_output` below the transient frame's number.

- The `emit` hook in `handleChatStream` fans the transient events to followers:

```js
if (name === 'shell_output' || name === 'subagent_event' || name === 'progress_update'
  || name === 'authorization_required' || name === 'ask_user_required') {
  liveChat.pushLive(runKey, name, data);          // buffered, replayed, has liveSeq
} else if (name === 'tool_result') {
  liveChat.pruneLive(runKey, data && data.id);
} else if (name === 'message' || name === 'reasoning') {
  liveChat.pushTransient(runKey, name, data);     // connected subscribers only
} else if (name === 'assistant_turn_end') {
  liveChat.pushTransient(runKey, name, Object.assign({}, data, {
    seq: nextLiveMessageSeq(runKey, assistantSegmentHasText)
  }));
  liveChat.setSegment(runKey, '', '');
}
```

- The `message`/`reasoning` handler keeps the mid-turn snapshot current only while someone is following (`if (liveChat.hasSubscribers(runKey)) liveChat.setSegment(...)`), so the ordinary turn — sending tab on its own SSE socket, no follower — pays nothing.

### Sequence-number prediction

A live segment is broadcast as a *row* before it is persisted, and the follower stamps the broadcast `seq` onto the node it drew so `reconcileTranscriptRows` (which keys rows by `seq` via `transcriptRowKey`) reuses that node instead of drawing the turn twice.

`nextLiveMessageSeq(runKey, hadText)` predicts the value with a per-chat counter (`liveSeqByChat`). Every append for a chat goes through this handler, so its next value is by construction the store's next value. Deriving the number from the transcript's last row would repeat a `seq` whenever two segments were persisted between two broadcasts — routine with tool rounds — and a duplicated `seq` is an identity collision, so the second row would be treated as a duplicate and culled.

A textless segment is never persisted, so it does not consume a seq (`assistantSegmentHasText` is captured from the same `assistantContent.trim() || assistantReasoning.trim()` guard that decides the append). Otherwise every textless tool round would push the prediction ahead of the store and every later boundary would miss. Matching is by equality only: a mismatch means the follower's node is simply not reused and a normal row is drawn, which is the pre-existing behavior.

The counter resets on server restart, where it under-predicts — the safe direction, for the same reason.

### Early shell output

Tool *call* rows are persisted, not broadcast, so a follower can receive `shell_output` for a card it has not drawn yet (the message sync that delivers the call row can land strictly later). `handleShellOutputEvent` therefore parks a chunk with no matching card in `refs._pendingShellOutput`, keyed by call id, and `appendToolCallCard` drains it into the `<pre>` the moment the shell card is built. The hold is capped at `PENDING_SHELL_OUTPUT_MAX_CHARS` (64 KiB) so a call the follower never learns about cannot accumulate without bound, and it is dropped on `run_end` along with the un-finalized live bubble.

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
