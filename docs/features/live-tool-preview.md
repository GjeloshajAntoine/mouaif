# Live tool preview on returning to a running chat

## Overview

When a chat is running, live output from long-running tools (such as terminal commands, nested subagent activity, progress indicators, and approval prompts) is streamed in real time to any client. If you navigate away and return or view the chat on another device, active tool runs display their live activity instead of a static waiting state.

## Usage

Open a chat that is running in another tab, or leave a running chat and come back to it. The transcript shows:

- the **assistant's reply streaming in**, token by token, exactly as it does in the tab that sent the message;
- each shell command's **output as it is produced**, from the first line rather than from whenever the page finished loading;
- nested **subagent activity**, progress bars, and approval prompts.

No controls are involved — the behavior is automatic while a run is in flight. When the run ends, the live views are replaced by the persisted transcript rows.

## Behavior

- **Live multi-client preview** — open a running chat on another tab or device to view the active tool output as it happens.
- **Fast reconnection** — returning to an active turn displays the live tool card immediately and blocks duplicate concurrent sends while following the run. A returning page syncs the transcript as soon as it sees the chat is running, then follows each saved row as it is announced ([live events](live-events.md)).
- **Streaming assistant text** — the reply text is fanned out to followers on the live stream as well as to the tab that sent it. A page that joins mid-reply is handed the segment produced so far and appends the deltas that follow.
- **No lost output** — shell output that arrives before its tool card exists is held per call id and drained into the card when it is created. Tool *call* rows are persisted rather than broadcast, so a follower can briefly receive output for a card it has not drawn yet; without the hold those early chunks were dropped permanently.
- **One row per segment** — a follower adopts the transcript sequence number the server broadcasts with each segment boundary, so the persisted copy reconciles onto the row it streamed into instead of appearing as a second bubble. The number is the store's own value (the seq the row was written with), never a counter-based prediction, so it is correct after a server restart; and the cheap tail-append sync skips a row whose node is already on screen under that identity, so the segment is not drawn twice on the common follower path.
- **Every segment closes, the last one too** — tool rounds get their boundary from the model stream, and the chat handler now broadcasts one for the final answer as well, carrying the saved row's `seq` and `clientId`. A follower therefore keeps its final bubble in place instead of dropping it at `run_end` and redrawing it from the next poll (no flash, no scroll jump).
- **The round's usage reaches the follower** — `usage_input` / `usage_output` are merged into one round snapshot on the server: connected followers get it as a `live_usage` frame, and a follower joining mid-segment receives it inside `live_segment`. The follower draws the same model / context / output / tok-s line under its bubble that the owner's stream draws, marked provisional so the saved row's numbers replace it. It is cleared at each segment boundary.
- **The reused bubble gets its info line** — a live bubble is drawn with the info line hidden, so when its saved row reconciles onto that same node the line is filled in there rather than staying hidden until a reload; a line the owner stream already drew (with live tok/s) is left alone.
- **Immediate completion sync** — when execution completes, the follower receives `run_end`, drops any un-finalized live bubble, resumes loading older history, and immediately reconciles the final persisted turn.
- **Seamless completion** — when execution completes, the tool card transitions to its finalized result state.
- **The outcome is reported** — `run_end` carries `outcome` (`done`, `stopped` or `error`), so a followed turn that failed shows an error and a cancelled one shows stopped, instead of always reading as done.
- **No duplicate live output on a handoff** — the buffered live frames the owner's own stream receives carry the same `liveSeq` cursor (and the run id) that a follower sees, so when the page hands its own stream over to the live follower the new subscription resumes after what is already on screen instead of replaying the whole buffer onto the same cards.
- **A running subagent's in-flight call survives** — a nested `tool_call` is now pruned *before* it is pushed, so the replay buffer keeps the call itself; only a nested `tool_result` prunes after, dropping the settled call as before.
- **No stale bubble after a socket drop** — resubscribing to the same run clears a live bubble left over from before the socket dropped. If its segment ended in the gap it is already a saved row; if not, the `live_segment` that follows redraws it.
- **Live generated images survive a return** — the live image row is skipped by the keyed reconcile and only removed at the end of the run, when the saved row carries the same picture.

## Recovery and replay

- Foreground (`visibilitychange`, `pageshow`, or window focus) replaces an established local stream with a live follower and performs an immediate incremental revision sync. This detaches only the browser reader; the server keeps executing. Requests still preparing or waiting for headers are left alone. Overlapping resume events and syncs are serialized.
- Both message and reasoning deltas are broadcast to followers. One current segment snapshot is maintained even without subscribers, so the first returning page receives the full partial reply. Reconnect snapshots replace retained partial text rather than appending it twice.
- `GET /api/chats/:id/live` accepts an optional `runId` alongside `fromLiveSeq`. The `live_subscribed` frame includes the server's run ID. A missing or different ID replays from zero and resets the client's cursor; a matching ID replays only unseen buffered events. This prevents an earlier turn's cursor from hiding a new turn's tools or approvals.
- Recovery restores pending prompts and live replay, and keeps the running controls and send guard active until the server reports completion. Unchanged transcript rows do not imply completion, and successful synchronization resets the consecutive-failure budget so slow generation or tools cannot time out locally.

Regression checks:

```bash
node scripts/test-chat-reentry.js
node scripts/test-chat-stream-abort.js
node scripts/test-live-subscription.js
node scripts/test-live-chat.js
node scripts/test-live-segment-seq.js
node scripts/test-transcript-append-keyed-row.js
npm run build:web
node scripts/test-chat-reentry-ui.mjs
```

The browser check uses a temporary API fixture and the built app at 360, 390, and 430 px. It does not restart the app server.

## Related

- [Chat UI](chat-ui.md)
- [Chat streaming performance](chat-streaming-performance.md)
- [Chat load performance](chat-load-performance.md)
- [Run settle latch](run-settle-latch.md)
- [Progress tool](progress-tool.md)

