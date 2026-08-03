# Chat load performance

## Overview

Opening a long, tool-heavy chat should feel instant even when the transcript runs to hundreds of messages and multiple megabytes. This page documents the server-side and client-side changes that keep chat load fast: SQL-side cost aggregation, a cheap transcript revision marker for polling, and lazy rendering of collapsed tool-result cards.

## Usage

No user-visible controls — the behavior is automatic. Open any chat (especially a long agentic one) and it paints progressively; the 1-second reconcile poll and the post-stream reconciliation no longer re-download the whole transcript unless something actually changed.

## Implementation notes

### Cost aggregation in SQL (`src/chatdb.js`, `src/chats.js`)

`GET /api/chats` previously summed each chat's cost by calling `listMessages` per chat — a full transcript read (968 rows, multi-MB for the largest) just to total a handful of assistant `cost` blocks. The DB backend now uses one indexed `GROUP BY` over `message_store`:

- `chatdb.projectCostTotals(projectDir)` — one aggregate for every chat of a project (used by `GET /api/chats` list enrichment and `recomputeProjectTotalCost`).
- `chatdb.chatTotalCostDb(projectDir, chatId)` — single-chat aggregate (used by `chats.chatTotalCost`).

The `json_extract` predicates replicate the old JS loop exactly (`cost.known === true && total >= 0`); verified identical totals on a 31-chat project (0/30 mismatches) and on an edge-case matrix (negative totals, non-numeric totals, non-assistant rows, `known:false`). Measured: chat-list enrichment 138 → 17 ms; `recomputeProjectTotalCost` (run after every stream) 166 → 7 ms.

The legacy JSON-file backend keeps its original JS loop (no SQL available there).

### Transcript revision marker (`src/messages.js`, `src/chatdb.js`, `GET /api/chats/:id/revision`)

The client's 1-second "another tab is running this chat" poll and the post-stream reconciliation used to re-fetch the **full** message list every tick just to `JSON.stringify` it and compare signatures. New endpoint returns `{ count, ts }` (one indexed `COUNT(*) + MAX(ts)`), which changes exactly when the append-only transcript changes. The client polls the marker; it only pulls the full `/messages` list (and re-renders) when the marker actually moved.

### Lazy collapsed tool-result bodies (`src/web/src/components/chat/transcript.js`)

`appendToolResultCard` previously built the full structured preview (result parse + per-tool renderer + diff/terminal rows) for every result even though the card is collapsed by default. The result payload is now stashed on the card and the body is built on first expand (errors still build immediately because they auto-expand). Measured on a 968-row tool-heavy transcript: DOM build 295 → 189 ms, scaling with result size.

### Fewer redundant refreshes (`src/web/src/components/chat/stream.js`)

- `refreshChatTitle` (a full `GET /api/chats/:id`) only fires while the chat still has a default title — the server only derives a title from the first prompt.
- The post-stream reconciliation is revision-gated like the poll.

### Allowlist regex startup race (`src/tools/authorization.js`)

`regexMatch` started its timeout clock when the worker thread came online — but a freshly spawned worker can take tens of milliseconds to start on a loaded machine, so allowlist patterns lost the startup race and were rejected as timeouts (flaky `test-tool-authorization`, real allowlist auth failures). The clock now starts only once the worker is actually running the pattern (floored at 1 s); catastrophic-backtracking protection is unchanged.

## Related

- [Chat storage](./chat-storage.md) — SQLite-backed messages.
- [Chat UI](./chat-ui.md) — the transcript shell.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
