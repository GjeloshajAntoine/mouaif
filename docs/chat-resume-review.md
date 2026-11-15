# Review: chat view bugs when coming back to a running chat

Date: 2026-11-14

Six bugs on the return-to-a-running-chat path. All come from reading the code; nothing was reproduced in a browser. Only the server-side buffer behaviour in finding 2 was confirmed, by a small simulation against `src/live-chat.js`.

Paths under `frontend/src/components/chat/` are written without the prefix (`stream.js`, `live.js`, `transcript.js`, `useChatState.js`).

## Likely to be seen often

### 1. Returning to a chat you started yourself duplicates live output

- **Cause:** on return, `resumeRunningChat` drops your own stream and subscribes to the replay stream (`stream.js:893`). Your own stream's frames carry no `liveSeq`, and `send()` zeroes the cursor (`stream.js:1007`), so the server replays its whole buffer from 0.
- **Effect:** `handleShellOutputEvent` (`transcript.js:1498`) and the subagent message path (`transcript.js:1687`) append without any dedupe. A still-running shell card shows its output twice, and a running subagent card repeats its text.
- **Trigger:** every window `focus` (`useChatState.js:1610`), so plain alt-tabbing back on desktop does it, not just a phone coming back from the background.

### 2. A running subagent's in-flight tool call is lost for anyone who returns

- **Cause:** the server pushes a nested `tool_call` into the replay buffer and then prunes by that same id, which deletes the event it just pushed (`src/server-handlers-chats.js:1013-1016`). In the simulation the replay held `start`, `message` and the nested `shell_output`, but not the `tool_call`.
- **Effect:** the returning page has no row for that call, so its output is silently dropped (`transcript.js:1733`).
- **Worse:** when the result arrives, the fallback fills it into the first unsettled row, which is a different call (`transcript.js:1791-1792`).

### 3. The final answer disappears and is redrawn when a followed run ends

- **Cause:** the last segment never gets an `assistant_turn_end` on the live stream; only tool rounds emit one (`src/ai-stream.js:1306`). `handleLiveRunEnd` therefore removes the streamed bubble (`live.js:274`), and the poll rebuilds it one round trip later.
- **Effect:** a flash and a scroll jump at the end of every run you came back to. That is every run, given the handoff in finding 1.

## Less frequent

### 4. A failed turn reports "done" after a return

`handleLiveRunEnd` always sets the status to `done` / success (`live.js:270`), even when the run ended in an error. After the handoff the page is a follower, so it also loses the things only your own stream does, such as the live tok/s and cost line.

### 5. A stale live bubble can stay next to its saved copy

If the live socket drops while the page stays visible, the next tick resubscribes without clearing the live row. If the segment ended in the gap, the server sends no `live_segment`, so the old bubble sits below the saved row until the run ends. How often this socket drop happens in practice is uncertain.

### 6. Live generated images vanish on return

The `chat-msg--live-image` row (`transcript.js:744`) has no key, so the keyed reconcile that runs after a return removes it (`transcript.js:3804`). The picture is gone until the saved row arrives.

## Suggested fixes

- **Finding 1:** have the owner stream's frames carry `liveSeq` and the run id, so the handoff resumes from the right cursor. Optionally, skip the handoff when the owner socket is still delivering.
- **Finding 2:** prune before pushing the nested `tool_call`, so the call itself stays in the buffer.
- **Finding 3:** broadcast a final boundary with the saved row's `clientId` before `run_end`, so the follower finalizes its bubble in place.

Findings 1–3 are the ones worth doing first. Findings 4–6 have no fix proposed yet.

## Status

All six are fixed; see the behavior list in [Live tool preview](features/live-tool-preview.md).
