# Chat streaming performance — implementation notes

> Agent-facing reference for [`docs/features/chat-streaming-performance.md`](../../features/chat-streaming-performance.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

The hot path lives in [frontend/src/components/chat/transcript.js](../../../frontend/src/components/chat/transcript.js).

- The first delta of a turn calls `ensureLiveStreamingBody(row)`, which renders the assistant body once (reasoning `<details>` + empty `.chat-msg__answer`), then marks the row as "streaming".
- Subsequent `appendDeltaToLive` / `appendReasoningToLive` calls append a `Text` node to the streaming answer / reasoning block. Appending a text node touches only the new bytes — it never re-encodes the accumulated string, unlike `textContent = fullString`.
- The streamed content is still plain text while live (cheap), matching the previous behavior. On `finalizeLiveMessage` the assembled turn is re-rendered once as markdown, so the finished bubble is identical to before.
- The "Thinking…" reasoning block streams live for **every** provider. OpenRouter used to buffer reasoning until the upstream turn completed (its text is buffered for MiniMax tool-call compatibility), but reasoning deltas never carry tool-call serialization, so `src/ai-stream.js` forwards them immediately like the other providers. Only the assistant *answer* text stays buffered for OpenRouter.
- If a reasoning delta arrives after the answer already started streaming without a reasoning block, the body is rebuilt once so the `<details>` block slots in ahead of the answer (preserving accumulated content). This is a rare one-time event, not a per-token cost.
- The `_content` / `_reasoning` accumulators are still updated on the row so `finalizeLiveMessage` and any rebuild have the authoritative full text.
- **Reconcile / recovery merges by `seq`, never re-adds a held row.** The single 1/3/6 s reconcile poll (`reconcileRunningChat` in `frontend/src/components/chat/stream.js`) drives both idle chat syncing and stream recovery in one loop: when the local SSE drops mid-turn, `startStreamRecovery` sets a `reconnecting` flag and kicks the same poll, which then syncs from disk (attempt-based backoff) until the turn settles. All sync paths pull rows through `mergeServerRows` (see `frontend/src/components/chat/msgMerge.js`). Rows the client already merged (either from the initial load or a prior tail) carry a stable per-chat `seq` that is in `state.seenSeqs`, so a redundant re-delivery is dropped. A persisted row that the client already rendered optimistically (the user message appended before the POST, or the live assistant bubble before the server persisted it) **replaces** its seq-less twin in place rather than being appended a second time.
  - This is what fixes the historic "last few messages repeat": the old code matched rows by `role + ts`, but the optimistic timestamp (client clock) differs from the persisted one (server clock), so the twin was drawn twice.
  - `fromSeq=` tail fetches are keyed on the highest known `seq`, not on `state.messages.length`, so a returning/follower client with optimistic seq-less live rows still asks for the next unmerged persisted row. This keeps catch-up incremental and avoids skipping rows until the run settles. See [chat-storage.md](./chat-storage.md) for the `seq` contract on both backends.

Token appends, transcript mutations, and resize notifications share one per-transcript animation-frame scheduler. A burst of deltas performs no synchronous scroll-height reads; each scheduled frame reads geometry once before writing the bottom position. Follow-up frames stop after the layout settles, while late image/tool growth can schedule another pass.

The scroll listener remains the source of truth for whether the reader is pinned. Scrolling up cancels following, Jump to latest re-enables it, and pagination/render suspension takes precedence. Pending frames are cancelled on cleanup. Resize observers track only direct message rows; nested text mutations no longer scan every row to rebuild that set.

## Live previews (shell output, subagent reply)

The two previews that stream *beside* the reply used the same O(n²) shape the assistant bubble had before the incremental fix. Both now append text nodes.

- `appendShellLiveChunk(pre, data)` — the shell card's live preview. Previously `pre.textContent += delta`, which re-encoded the whole accumulated string per chunk, plus an `includes('\n── stderr ──\n')` scan of the full text per stderr chunk. The marker is now tracked per element (`_stderrMarked`) and the length in `_liveChars`, so neither is recovered by scanning.
- `SHELL_LIVE_PREVIEW_MAX_CHARS` (120 KiB) bounds the preview. Past the cap the tail is replaced by `SHELL_LIVE_TRUNCATION_NOTICE`, once; the `tool_result` that replaces the preview carries the complete output, so nothing is lost. An unbounded live preview was the other half of the stall on returning to a running chat, where the whole buffered output replays in one burst.
- `handleSubagentStreamEvent` — the `message` branch built the nested bubble with `renderAssistantBody(rowBody, live._text, '', false)` on **every** delta, i.e. `innerHTML = ''` plus a full re-set of the accumulated reply, tearing the bubble down and recreating it per token. It now creates the row and its answer element once and calls `appendTextToAnswer` per delta, the same shape `appendDeltaToLive` uses. `scripts/test-subagent-transcript-parity.js` asserts the answer element is *reused* across deltas, which is what distinguishes the two implementations.
- Nested shell previews inside a subagent card go through the same `appendShellLiveChunk`.

### Scroll coalescing

`scrollToolBodyToBottomSoon` (frontend/src/components/chat/scroll.js) replaces `scrollToolBodyToBottom` on every live-preview path. The old helper read `scrollHeight` and wrote `scrollTop` — a forced layout — and then scheduled a second, identical pair on the next frame: two synchronous layouts per chunk.

The new one does the work inside a single `requestAnimationFrame` per body. A chunk that finds a frame already queued returns immediately, so a burst of N chunks schedules one frame and reads layout once. The follow-up re-pin is bounded by `MAX_BODY_SCROLL_FRAMES` (4), `body.isConnected === false` stops the loop for a body that left the document, and `cancelToolBodyScroll` (called from `appendToolResultCard`'s `lazyBody`, which replaces the preview) neutralises a queued frame. A browser `requestAnimationFrame` cannot be un-queued, so cancellation flags the frame rather than dropping it, and a later schedule starts from a fresh entry.

`scripts/test-live-scroll-coalescing.js` counts frames and layout reads against a stub body, so restoring the per-chunk version fails it.
