# Run settle latch — implementation notes

> Agent-facing reference for [`docs/features/run-settle-latch.md`](../../features/run-settle-latch.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Files: `frontend/src/components/chat/useChatState.js` (the `runSettled` and `liveRun` refs, accessors, reset effects), `frontend/src/components/chat/live.js` (live-socket state), and `frontend/src/components/chat/stream.js` (`reconcileRunningChat`).
- `live.js` marks the follower replay socket as active/connected/ended/failed in `state.liveRun` without triggering Preact renders.
- `reconcileRunningChat` reads both `state.runSettled` and the live-socket state:
```js
const liveConnected = !!(liveState
  && (liveState.active || liveState.connected)
  && !liveState.ended
  && !liveState.failed);

if (state.runSettled) {
  state.watchingRun = false;
  state.watchingStableTicks = 0;
} else if (!moved && !midTool && state.messages.length > 0 && !liveConnected) {
  state.watchingStableTicks = (state.watchingStableTicks || 0) + 1;
  if (state.watchingStableTicks >= 2) {
    state.runSettled = true;
    // ... show "done"
  }
}
```
- The latch is also set when the follower live socket receives `run_end`, so a final in-memory `running` tick cannot repaint "streaming…" after the socket already told the UI the run ended.
- The latch is cleared when `syncToNextSeq` sees the server cursor advance, so a real persisted append re-enables the busy state for the next run.
- Tail sync updates `state.transcriptNextSeq` even when all fetched rows are already known. That prevents a repeated cursor value with duplicate rows from being treated as "new" on every later poll.
