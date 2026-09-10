# Chat load performance — implementation notes

> Agent-facing reference for [`docs/features/chat-load-performance.md`](../../features/chat-load-performance.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### Cost aggregation in SQL (`src/chatdb.js`, `src/chats.js`)

`GET /api/chats` previously aggregated assistant costs from `message_store` whenever the list opened. Costs are now maintained on write:

- `chat_store.total_cost` and `chat_store.cost_known_count` hold each chat's persisted summary.
- The registered project row in app settings holds `totalCost`, including an internal `knownCount` used to preserve `known` when costs are removed.
- `chatdb.appendMessage`, `replaceMessages`, `clearMessages`, and `deleteChat` update both layers by delta.
- `GET /api/chats` applies `offset` and `limit` in SQLite, reads each returned row's `totalCost`, and runs a separate indexed `COUNT(*)` for the pagination total. It does not materialize or sort the project's full chat history.
- `recomputeProjectTotalCost` remains only for migration, registration, and import backfills; normal stream completion does not call it.

Only assistant messages with `cost.known === true` and a finite non-negative total affect metadata. The original cost object remains persisted on the message for traceability.

### Transcript cursor (`src/messages.js`, `src/chatdb.js`, `GET /api/chats/:id/revision`)
The client's "another tab is running this chat" poll and the post-stream reconciliation use a single append-only cursor instead of a fuzzy count/timestamp marker. The endpoint returns `{ nextSeq, running }`, where `nextSeq` is the first persisted transcript row the client may not have merged yet. The `running` flag rides the same response so the poll is a single request per tick.
### Incremental transcript sync (`frontend/src/components/chat/stream.js` → `syncToNextSeq`, `transcript.js` → `syncTranscriptAppend`)
When the server cursor is ahead of the local cursor, the client fetches and renders only the tail. A full rebuild is reserved for the rare invariant break where the server cursor is behind the local cursor (clear/replace/import/corruption), not normal stream comeback.
### Tail-only fetch (`GET /api/chats/:id/messages?fromSeq=<seq>`)
The messages endpoint accepts `fromSeq=<seq>`, the next persisted row the caller has not merged, and returns `{ messages, nextSeq }` with only rows appended at or after that seq. The client computes `fromSeq` from the highest known stable `seq` (not `state.messages.length`), so optimistic seq-less live rows never make a returning/follower page skip persisted rows while the run is still streaming. Steady-state cost of following a run is one tiny `/revision` GET per tick plus, only when `nextSeq` advances, the few new rows.
### Visibility-aware poll cadence (`frontend/src/components/chat/useChatState.js`)

The reconcile poll is cadence-adaptive: **1 s while this tab is following a run from another tab** (`watchingRun`), **3 s while visible and idle**, and **6 s while `document.visibilityState === 'hidden'`**. An idle open chat used to hit `/revision` once a second forever (pure battery/network/CPU); it now backs off to a slow poll and only snaps back to 1 s when there is actually a run to follow. Becoming visible ticks immediately so the "done" flip isn't delayed beyond the next tick.

### Torn-run settlement (`frontend/src/components/chat/stream.js` → `reconcileRunningChat`, `useChatState.js`)

When the SSE socket dies but the run survives on the server, a **reloaded** page used to keep `'streaming…'` forever: the reconcile poll saw `running:true`, set the busy state, and re-fetched `/revision` (and `/pending`) every second with no way to settle a run whose transcript had stopped moving. `reconcileRunningChat` now carries a `watchingStableTicks` counter: if the transcript is stable (not mid-tool) across a couple of identical polls, it clears the busy state like `runRecoveryTick` does on the same page. The pending-authorization queue is also drained only when the run just started or rows arrived — not on every tick (it was an extra `GET /pending` per second).

### Latest-first progressive render (`frontend/src/components/chat/transcript.js` → `renderTranscriptChunked` / `renderTranscriptBackfill`)

A long transcript (≥ `TRANSCRIPT_CHUNK_THRESHOLD`, 120 rows) used to render top-down from row 0 and only reveal the newest turn once the **whole** transcript had been built — so a big chat opened slow, scrolled up from the top, and appeared to "load from the beginning". The chunked render is now **tail-first**:

1. **Phase 1 (synchronous, bounded).** Compute the render order (skipping empty assistant turns), then append only the newest `TRANSCRIPT_CHUNK_ROWS` (40) rows at the bottom and pin. The first paint cost is fixed regardless of transcript length, and the latest message is on screen on frame one.
2. **Phase 2 (rAF chunks).** Backfill older rows **above** an insertion anchor (`refs._insertAnchor`, honored by `transcriptInsert`). Walking backwards and inserting each older row before the current first backfilled row keeps the net order chronological. After each chunk the scroll position is compensated by the height the inserted rows added above the viewport, so the view never jumps while history fills in behind the tail.

`renderMessageRow` gained a de-dup guard: a tool `call` row is skipped when a card for its `toolCallId` is already on screen. Tail-first means a `tool_result` in the tail can render before its `tool_call` (which sits in the backfill), and an overlapping reconcile/recovery sync can re-render a row this client already appended — without the guard the call card was duplicated and stuck on "Waiting…". `resetTranscriptRender` clears `refs._insertAnchor` so a superseded pass (or a live append after the render) can never insert mid-transcript.

### Scroll preservation on rebuild (`frontend/src/components/chat/transcript.js` → `scrollTranscriptToBottomImpl`)

A full transcript rebuild no longer unconditionally pins the view to the bottom. `scrollTranscriptToBottomImpl` only forces `scrollTop = scrollHeight` when the user was already pinned; a mid-view rebuild (recovery/reconcile) leaves an unpinned user's reading position alone instead of yanking them down. The initial load still pins because `pinnedToBottom` defaults to true.

### Overlay-card anchoring (`frontend/src/components/chat/transcript.js` → `reanchorOverlayCards`)

Authorization / ask_user overlay cards are modal-ish and live at the bottom of the transcript. After a tail sync renders new message rows they could get stranded mid-transcript (the card floats "at a random place" above content that arrived later). `syncTranscriptAppend` now re-anchors any standing overlay card to the very bottom after appending rows.

### No redundant model PATCH per send (`frontend/src/components/chat/stream.js`)

`send()` used to PATCH `{providerId, modelId}` on every turn even though the model picker already persists the pair on selection. The hook tracks the last pair the server confirmed (`state._persistedModelPair`, seeded from the load response and updated after every successful PATCH); `send()` skips the PATCH when it matches.

### Lazy collapsed tool-result bodies (`frontend/src/components/chat/transcript.js`)

`appendToolResultCard` previously built the full structured preview (result parse + per-tool renderer + diff/terminal rows) for every result even though the card is collapsed by default. The result payload is now stashed on the card and the body is built on first expand (errors still build immediately because they auto-expand). Measured on a 968-row tool-heavy transcript: DOM build 295 → 189 ms, scaling with result size.

The build-on-expand hook lives **inside the head's own toggle handler** (`buildToolCardHead`): when a tap opens the card the handler calls `card._lazyBody()`. This is robust regardless of head replacement or listener ordering. An earlier design used a *separate* click listener armed on the head, but the head is replaced on every result (`rebuildToolCardHead`), so that listener was silently dropped and expanded cards showed an empty body. When a rebuild restores the user's expanded cards (`restoreExpandedState`), cards with a pending lazy body are built immediately — restoring the class alone would show an empty body.

Shell and subagent call cards auto-expand while running (live output/nested activity is only visible when expanded since the CSS exception for always-visible call bodies was removed) and fold back on a successful result unless the user manually collapsed them; errors auto-expand as before. Subagent cards keep their body visible even when collapsed (`.tool-card--subagent` rule), so the final nested chat is still readable without a tap.

### Fewer redundant refreshes (`frontend/src/components/chat/stream.js`)

- `refreshChatTitle` (a full `GET /api/chats/:id`) only fires while the chat still has a default title — the server only derives a title from the first prompt.
- The post-stream reconciliation is revision-gated like the poll.

### Allowlist regex startup race (`src/tools/authorization.js`)

`regexMatch` started its timeout clock when the worker thread came online — but a freshly spawned worker can take tens of milliseconds to start on a loaded machine, so allowlist patterns lost the startup race and were rejected as timeouts (flaky `test-tool-authorization`, real allowlist auth failures). The clock now starts only once the worker is actually running the pattern (floored at 1 s); catastrophic-backtracking protection is unchanged.

## Rebuild safety (chunked transcript render)

- Overlay cards (`ask_user` / authorization) are **not** detached during a
  rebuild. `clearTranscriptRows` in
  `frontend/src/components/chat/transcript.js` removes every child that is
  not matched by `OVERLAY_CARD_SELECTOR`, so the cards stay in the DOM and
  stay discoverable by `authCardGuard` / `removeOverlayCards` in
  `frontend/src/components/chat/overlay.js`. `renderTranscript` then calls
  `reanchorOverlayCards` right after the header cards are mounted, and once
  more when the render finishes, to put the cards back at the bottom.
  Previously the cards were pulled into a local array and re-appended at
  the end of the pass: if a second `renderTranscript` landed while the first
  chunked pass was still backfilling, the second `querySelectorAll` found
  nothing (the first had already removed them) and the cancelled first pass
  never re-attached them, silently dropping an unanswered question.
- `renderTranscriptBackfill` clears `refs._pendingTranscriptChunk` as its
  first statement, before any early return. `whenTranscriptSettled` polls
  that field every animation frame, so an early return that left the frame
  id set spun the poll forever and blocked every later overlay-card mount.
- The `refs._suspendScrollPin` / `refs._insertAnchor` toggles in the tail
  phase, the backfill loop and `prependOlderTranscript` are wrapped in
  `try/finally`: a throw inside a row renderer would otherwise leave scroll
  pinning disabled for the rest of the session.
