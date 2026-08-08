# Chat load performance

## Overview

Opening a long, tool-heavy chat should feel instant even when the transcript runs to hundreds of messages and multiple megabytes. This page documents the server-side and client-side changes that keep chat load fast: SQL-side cost aggregation, a cheap transcript revision marker for polling, and lazy rendering of collapsed tool-result cards.

## Usage

No user-visible controls — the behavior is automatic. Open any chat (especially a long agentic one) and it paints progressively; the 1-second reconcile poll and the post-stream reconciliation no longer re-download the whole transcript unless something actually changed — and when it did, they transfer only the rows appended after the client's known prefix.

## Implementation notes

### Cost aggregation in SQL (`src/chatdb.js`, `src/chats.js`)

`GET /api/chats` previously summed each chat's cost by calling `listMessages` per chat — a full transcript read (968 rows, multi-MB for the largest) just to total a handful of assistant `cost` blocks. The DB backend now uses one indexed `GROUP BY` over `message_store`:

- `chatdb.projectCostTotals(projectDir)` — one aggregate for every chat of a project (used by `GET /api/chats` list enrichment and `recomputeProjectTotalCost`).
- `chatdb.chatTotalCostDb(projectDir, chatId)` — single-chat aggregate (used by `chats.chatTotalCost`).

The `json_extract` predicates replicate the old JS loop exactly (`cost.known === true && total >= 0`); verified identical totals on a 31-chat project (0/30 mismatches) and on an edge-case matrix (negative totals, non-numeric totals, non-assistant rows, `known:false`). Measured: chat-list enrichment 138 → 17 ms; `recomputeProjectTotalCost` (run after every stream) 166 → 7 ms.

The legacy JSON-file backend keeps its original JS loop (no SQL available there).

### Transcript revision marker (`src/messages.js`, `src/chatdb.js`, `GET /api/chats/:id/revision`)

The client's "another tab is running this chat" poll and the post-stream reconciliation used to re-fetch the **full** message list every tick just to `JSON.stringify` it and compare signatures. The endpoint returns `{ count, ts, running }` (one indexed `COUNT(*) + MAX(ts)`, plus the in-memory running flag) which changes exactly when the append-only transcript changes. The client polls the marker; it only pulls the full `/messages` list when the marker actually moved. The `running` flag rides the same response so the poll is a single request per tick (previously chat GET + revision GET). The client no longer keeps a full-transcript `JSON.stringify` signature at all — the recovery poll after a dropped SSE connection is revision-gated the same way.

### Incremental transcript sync (`frontend/src/components/chat/stream.js` → `syncFromRevision`, `transcript.js` → `syncTranscriptAppend`)

When the marker moves, the synced rows used to replace `state.messages` and trigger a full `renderTranscript` rebuild — re-parsing every message's markdown and scroll-jumping the view, once a second while following a run from another tab. The message store is append-only (edits go through `replaceMessages`/`clearMessages`, which change the row count), so the client now compares the prefix — unchanged prefix → render just the new tail rows; prefix changed (defensive; unreachable today) → full rebuild.

The prefix comparison uses **logical equality** (`sameMessage`: role + ts + toolCallId + phase), not object identity. The fallback path that reaches `syncFromRevision` carries a freshly `JSON.parse`d full fetch, so a reference `===` comparison was always false and forced a blank-and-repaint (and a scroll reset) on the first recovery/reconcile tick that hit the fallback — the "black screen" and "scroll jumps by itself" bug. Comparing by a stable key means an unchanged prefix keeps the cheap incremental tail path.

### Tail-only fetch (`GET /api/chats/:id/messages?since=<index>`)

Even with the revision gate, a moved marker used to mean re-downloading the **entire** transcript to learn what changed — megabytes on a long tool-heavy chat, once per second while following a run. The messages endpoint now accepts `since=<index>`, the number of rows the caller already has, and returns `{ messages, base }` with only the rows appended after that index; `base` echoes the server-side row count the slice was taken from. A `base` smaller than `since` means the transcript shrank on the server (`clearMessages` — not a pure append), and the client falls back to a full fetch + rebuild. All three catch-up paths use it via `syncTailOrFull` in `frontend/src/components/chat/stream.js`: the reconcile poll, the stream-recovery poll after a dropped SSE connection, and the post-stream reconciliation. Steady-state cost of following a run is now one tiny `/revision` GET per tick plus, only on change, the few new rows.

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

## Related

- [Chat storage](./chat-storage.md) — SQLite-backed messages.
- [Chat UI](./chat-ui.md) — the transcript shell.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
