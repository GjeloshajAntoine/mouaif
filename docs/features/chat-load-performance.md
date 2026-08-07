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

### Incremental transcript sync (`src/web/src/components/chat/stream.js` → `syncFromRevision`, `transcript.js` → `syncTranscriptAppend`)

When the marker moves, the synced rows used to replace `state.messages` and trigger a full `renderTranscript` rebuild — re-parsing every message's markdown and scroll-jumping the view, once a second while following a run from another tab. The message store is append-only (edits go through `replaceMessages`/`clearMessages`, which change the row count), so the client now compares the prefix by identity: unchanged prefix → render just the new tail rows; prefix changed (defensive; unreachable today) → full rebuild.

### Tail-only fetch (`GET /api/chats/:id/messages?since=<index>`)

Even with the revision gate, a moved marker used to mean re-downloading the **entire** transcript to learn what changed — megabytes on a long tool-heavy chat, once per second while following a run. The messages endpoint now accepts `since=<index>`, the number of rows the caller already has, and returns `{ messages, base }` with only the rows appended after that index; `base` echoes the server-side row count the slice was taken from. A `base` smaller than `since` means the transcript shrank on the server (`clearMessages` — not a pure append), and the client falls back to a full fetch + rebuild. All three catch-up paths use it via `syncTailOrFull` in `src/web/src/components/chat/stream.js`: the 1 s reconcile poll, the stream-recovery poll after a dropped SSE connection, and the post-stream reconciliation. Steady-state cost of following a run is now one tiny `/revision` GET per tick plus, only on change, the few new rows.

### Visibility-aware poll cadence (`src/web/src/components/chat/useChatState.js`)

The reconcile poll ticks every 1 s while the tab is visible and drops to 5 s while `document.visibilityState === 'hidden'` (a backgrounded tab needs only eventual consistency; the per-second tick is battery/network cost). Becoming visible ticks immediately. A run being followed from another tab (`watchingRun`) keeps the 1 s cadence even when hidden so the "done" flip isn't delayed.

### No redundant model PATCH per send (`src/web/src/components/chat/stream.js`)

`send()` used to PATCH `{providerId, modelId}` on every turn even though the model picker already persists the pair on selection. The hook tracks the last pair the server confirmed (`state._persistedModelPair`, seeded from the load response and updated after every successful PATCH); `send()` skips the PATCH when it matches.

### Lazy collapsed tool-result bodies (`src/web/src/components/chat/transcript.js`)

`appendToolResultCard` previously built the full structured preview (result parse + per-tool renderer + diff/terminal rows) for every result even though the card is collapsed by default. The result payload is now stashed on the card and the body is built on first expand (errors still build immediately because they auto-expand). Measured on a 968-row tool-heavy transcript: DOM build 295 → 189 ms, scaling with result size.

The build-on-expand hook lives **inside the head's own toggle handler** (`buildToolCardHead`): when a tap opens the card the handler calls `card._lazyBody()`. This is robust regardless of head replacement or listener ordering. An earlier design used a *separate* click listener armed on the head, but the head is replaced on every result (`rebuildToolCardHead`), so that listener was silently dropped and expanded cards showed an empty body. When a rebuild restores the user's expanded cards (`restoreExpandedState`), cards with a pending lazy body are built immediately — restoring the class alone would show an empty body.

Shell and subagent call cards auto-expand while running (live output/nested activity is only visible when expanded since the CSS exception for always-visible call bodies was removed) and fold back on a successful result unless the user manually collapsed them; errors auto-expand as before. Subagent cards keep their body visible even when collapsed (`.tool-card--subagent` rule), so the final nested chat is still readable without a tap.

### Fewer redundant refreshes (`src/web/src/components/chat/stream.js`)

- `refreshChatTitle` (a full `GET /api/chats/:id`) only fires while the chat still has a default title — the server only derives a title from the first prompt.
- The post-stream reconciliation is revision-gated like the poll.

### Allowlist regex startup race (`src/tools/authorization.js`)

`regexMatch` started its timeout clock when the worker thread came online — but a freshly spawned worker can take tens of milliseconds to start on a loaded machine, so allowlist patterns lost the startup race and were rejected as timeouts (flaky `test-tool-authorization`, real allowlist auth failures). The clock now starts only once the worker is actually running the pattern (floored at 1 s); catastrophic-backtracking protection is unchanged.

## Related

- [Chat storage](./chat-storage.md) — SQLite-backed messages.
- [Chat UI](./chat-ui.md) — the transcript shell.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
