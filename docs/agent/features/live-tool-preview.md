# Live tool preview on returning to a running chat — implementation notes

> Agent-facing reference for [`docs/features/live-tool-preview.md`](../../features/live-tool-preview.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Files:
  - `src/live-chat.js` — the per-chat live-replay registry: `ensureLiveChat`, `setSegment`, `hasSubscribers`, `pushLive`, `pushTransient`, `pruneLive`, `addSubscriber`, `finishLiveChat`; assigns monotonic `liveSeq` values and filters replay by `fromLiveSeq`.
  - `src/server-shared.js` — exports the module (`liveChat`).
  - `src/server-handlers-chats.js` — the `/api/chats/:id/live` route; `handleChatStream` calls `ensureLiveChat` at run start, `pushLive`/`pushTransient`/`pruneLive`/`setSegment` inside `emit`, and `finishLiveChat` at every exit. Also holds `assistantSegmentSeq` (the seq the last persisted segment row was written with).
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
  liveChat.pushTransient(runKey, name, assistantSegmentSeq == null
    ? data
    : Object.assign({}, data, { seq: assistantSegmentSeq }));
  liveChat.setSegment(runKey, '', '');
}
```

- The `message`/`reasoning` handler keeps the mid-turn snapshot current only while someone is following (`if (liveChat.hasSubscribers(runKey)) liveChat.setSegment(...)`), so the ordinary turn — sending tab on its own SSE socket, no follower — pays nothing.

### Segment seq is the persisted row's own value

A live segment is broadcast as a *row* before it is persisted, and the follower stamps the broadcast `seq` onto the node it drew so `reconcileTranscriptRows` (which keys rows by `seq` via `transcriptRowKey`) reuses that node instead of drawing the turn twice.

The number must be the value the store actually assigned. The broadcast therefore reuses the `appendMessage` return value: the `assistant_turn_end` handler keeps the appended row in `segmentRow` and sets `assistantSegmentSeq = segmentRow.seq` (or `null` when the segment produced no text and nothing was appended), and that value rides the frame. The append happens **before** the frame is pushed, so the number is already known — there is no need to predict it.

A textless segment persists nothing, so `assistantSegmentSeq` stays `null` and the frame carries **no** `seq` at all. A follower that sees no `seq` leaves its node unkeyed for the next full rebuild to drop.

Do not reintroduce a predicted/projected seq. An earlier implementation kept a process-local per-chat counter (`liveSeqByChat`) and broadcast `nextLiveMessageSeq(runKey, hadText)`; it was removed because:

- it resets to 0 on restart while the store keeps assigning `MAX(seq)+1`, so on an existing chat it collided with a real row's key — the follower either had its fresh bubble culled as a duplicate (a visible flash) or had it adopted the identity of an older on-screen message and moved to that message's position;
- its no-text branch re-sent the previous segment's number rather than sending no seq.

### The follower's completion path

The cheap tail sync is what a follower reaches on the common completion path, and it must not draw a row that is already on screen:

- `finalizeLiveSegment` (frontend) stamps the streamed bubble with the broadcast `seq`, but the follower never adds its live reply to `state.messages`;
- when the persisted row arrives, `mergeServerRows` sees a pure append and `tailSyncDomAction` returns `'append'`, routing to `syncTranscriptAppend` — **not** to `reconcileTranscriptRows`, the only path that matched rows by key;
- `syncTranscriptAppend` therefore looks the row's `transcriptRowKey` up among the mounted rows (`findKeyedRow`) and skips a row whose node is already present, instead of building a second bubble next to the live one.

Tests: `scripts/test-live-segment-seq.js` (server: the broadcast seq equals the persisted row's seq even with pre-existing history, so a restart-zero prediction fails it) and `scripts/test-transcript-append-keyed-row.js` (frontend: the keyed append skips an already-mounted row, and still appends genuinely new ones).

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
