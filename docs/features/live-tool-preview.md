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
- **Fast reconnection** — returning to an active turn displays the live tool card immediately and blocks duplicate concurrent sends while following the run. A returning page arms the follow poll as soon as it sees the chat is running, so the first transcript sync is immediate rather than waiting out an idle interval.
- **Streaming assistant text** — the reply text is fanned out to followers on the live stream as well as to the tab that sent it. A page that joins mid-reply is handed the segment produced so far and appends the deltas that follow.
- **No lost output** — shell output that arrives before its tool card exists is held per call id and drained into the card when it is created. Tool *call* rows are persisted rather than broadcast, so a follower can briefly receive output for a card it has not drawn yet; without the hold those early chunks were dropped permanently.
- **One row per segment** — a follower adopts the transcript sequence number the server broadcasts with each segment boundary, so the persisted copy reconciles onto the row it streamed into instead of appearing as a second bubble. The number is the store's own value (the seq the row was written with), never a counter-based prediction, so it is correct after a server restart; and the cheap tail-append sync skips a row whose node is already on screen under that identity, so the segment is not drawn twice on the common follower path.
- **Immediate completion sync** — when execution completes, the follower receives `run_end`, drops any un-finalized live bubble, resumes loading older history, and immediately reconciles the final persisted turn without waiting on background poll intervals.
- **Seamless completion** — when execution completes, the tool card transitions to its finalized result state.

## Related

- [Chat UI](chat-ui.md)
- [Chat streaming performance](chat-streaming-performance.md)
- [Chat load performance](chat-load-performance.md)
- [Run settle latch](run-settle-latch.md)
- [Progress tool](progress-tool.md)

