# Chat streaming performance

## Overview

The chat transcript renders assistant text **incrementally** while an SSE turn is streaming. Each token delta is appended as a single text node instead of rebuilding the whole assistant bubble from the full accumulated string. This removes the O(n²) re-encode and per-token DOM teardown/recreate that made long turns burn CPU and memory.

## Usage

No user-visible controls — the behavior is automatic. Open a chat and watch a long response stream: the text appears progressively with the same look as before, but the page stays responsive.

## Implementation notes

The hot path lives in [frontend/src/components/chat/transcript.js](../../frontend/src/components/chat/transcript.js).

- The first delta of a turn calls `ensureLiveStreamingBody(row)`, which renders the assistant body once (reasoning `<details>` + empty `.chat-msg__answer`), then marks the row as "streaming".
- Subsequent `appendDeltaToLive` / `appendReasoningToLive` calls append a `Text` node to the streaming answer / reasoning block. Appending a text node touches only the new bytes — it never re-encodes the accumulated string, unlike `textContent = fullString`.
- The streamed content is still plain text while live (cheap), matching the previous behavior. On `finalizeLiveMessage` the assembled turn is re-rendered once as markdown, so the finished bubble is identical to before.
- The "Thinking…" reasoning block streams live for **every** provider. OpenRouter used to buffer reasoning until the upstream turn completed (its text is buffered for MiniMax tool-call compatibility), but reasoning deltas never carry tool-call serialization, so `src/ai-stream.js` forwards them immediately like the other providers. Only the assistant *answer* text stays buffered for OpenRouter.
- If a reasoning delta arrives after the answer already started streaming without a reasoning block, the body is rebuilt once so the `<details>` block slots in ahead of the answer (preserving accumulated content). This is a rare one-time event, not a per-token cost.
- The `_content` / `_reasoning` accumulators are still updated on the row so `finalizeLiveMessage` and any rebuild have the authoritative full text.
- **Reconcile / recovery merges by `seq`, never re-adds a held row.** The single 1/3/6 s reconcile poll (`reconcileRunningChat` in `frontend/src/components/chat/stream.js`) drives both idle chat syncing and stream recovery in one loop: when the local SSE drops mid-turn, `startStreamRecovery` sets a `reconnecting` flag and kicks the same poll, which then syncs from disk (attempt-based backoff) until the turn settles. All sync paths pull rows through `mergeServerRows` (see `frontend/src/components/chat/msgMerge.js`). Rows the client already merged (either from the initial load or a prior tail) carry a stable per-chat `seq` that is in `state.seenSeqs`, so a redundant re-delivery is dropped. A persisted row that the client already rendered optimistically (the user message appended before the POST, or the live assistant bubble before the server persisted it) **replaces** its seq-less twin in place rather than being appended a second time.
  - This is what fixes the historic "last few messages repeat": the old code matched rows by `role + ts`, but the optimistic timestamp (client clock) differs from the persisted one (server clock), so the twin was drawn twice.
  - `since=` tail fetches are keyed on the highest known `seq`, not on `state.messages.length`, so a returning/follower client with optimistic seq-less live rows still asks for the next unmerged persisted row. This keeps catch-up incremental and avoids skipping rows until the run settles. See [chat-storage.md](./chat-storage.md) for the `seq` contract on both backends.

## Related

- [Chat UI](./chat-ui.md) — the Preact + Vite shell that hosts the transcript.
- [Usage metrics](./usage-metrics.md) — the live token-speed meta line repaints on a separate 120 ms throttle, independent of this path.
