# Chat load performance

## Overview

Opening a long, tool-heavy chat should feel instant even when the transcript runs to hundreds of messages and multiple megabytes. This page documents the server-side and client-side changes that keep chat load fast: SQL-side cost aggregation, a cheap transcript revision marker for polling, and lazy rendering of collapsed tool-result cards.

## Usage

No user-visible controls — the behavior is automatic. Open any chat (especially a long agentic one) and it paints progressively; the 1-second reconcile poll and the post-stream reconciliation no longer re-download the whole transcript unless something actually changed — and when it did, they transfer only the rows appended after the client's known prefix.

Returning to the Chats tab reads only the visible page of chat metadata and its persisted cost totals. Projects with long histories and active or very large transcripts therefore do not delay the visible project chat list.

## Implementation notes

When a known cost is appended to an assistant message, the same write path increments `chat_store.total_cost` and the registered project's `totalCost`. Clearing, replacing, or deleting transcript data applies the inverse delta. `GET /api/chats` applies `offset` and `limit` in SQLite, uses a separate indexed count for `total`, and never aggregates `message_store`; a one-time migration backfills existing histories.

## Related

- [Chat storage](./chat-storage.md) — SQLite-backed messages.
- [Chat UI](./chat-ui.md) — the transcript shell.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
