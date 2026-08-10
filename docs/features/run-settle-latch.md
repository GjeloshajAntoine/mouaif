# Run settle latch

## Overview

Fixes an oscillation where returning to a chat whose server `running` flag is stale flickered between "streaming…" (stop button shown) and "done" on every poll. A returned-to run is settled once and stays settled until a genuinely new turn lands on disk.

## Background

When a chat is running in another tab, or its SSE socket dies mid-turn, the server keeps reporting `running: true` on `GET /api/chats/:id/revision` even after the underlying run finished (the clear that would flip the flag rides the now-closed socket). The client-side reconcile poller used stability heuristics to settle such a "torn" run — but once settled it set `watchingRun = false`, so the very next poll saw `running: true` again, re-armed the busy state, and the cycle repeated forever. The user saw the send button morph into the stop button and back, and the status pill flip between "streaming…" and "done," every few seconds.

## Usage

No user action required. Reopening a finished chat, or navigating back to it, now settles at "done" and stays there. The stop button only appears for runs that are genuinely still producing output.

## Behavior

- A stale `running` flag is settled as done after two stable polls, then the settle is **latched**.
- Active but quiet runs are not mistaken for stale runs while the follower live socket is connected or connecting. This avoids a real run flipping to "done" during long model-thinking or tool-wait gaps, then back to "streaming…" on the next tick.
- While latched, the poller keeps the chat in the quiet "done" state — no re-arming of the stop button or status text — regardless of the still-stale server flag.
- The latch clears only when the transcript revision actually moves (a new message/tool result lands on disk), which is the only reliable signal a fresh run started. A genuinely new run shows its busy state as normal.
- The latch resets on chat/project change and on mount.

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
## Related

- [Chat UI](chat-ui.md)
- [Chat streaming performance](chat-streaming-performance.md)
- Source: `frontend/src/components/chat/stream.js`, `frontend/src/components/chat/useChatState.js`