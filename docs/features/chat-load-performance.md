# Chat load performance

## Overview

Opening a long, tool-heavy chat should feel instant even when the transcript runs to hundreds of messages and multiple megabytes. This page documents the server-side and client-side changes that keep chat load fast: SQL-side cost aggregation, a cheap transcript revision marker for polling, lazy rendering of collapsed tool-result cards, and windowed backward pagination so only the newest page of a long transcript loads on open.

## Usage

No user-visible controls — the behavior is automatic. Open any chat (especially a long agentic one) and it paints progressively; the 1-second reconcile poll and the post-stream reconciliation no longer re-download the whole transcript unless something actually changed — and when it did, they transfer only the rows appended after the client's known prefix. A long chat additionally loads just its newest page up front; older history is fetched on demand as the user scrolls to the top (see [Chat backward pagination](./chat-backward-pagination.md)).

Returning to the Chats tab reads only the visible page of chat metadata and its persisted cost totals. Projects with long histories and active or very large transcripts therefore do not delay the visible project chat list.

## Latest-first transcript rendering

A long transcript paints its newest rows first and backfills older history above them, one animation frame at a time, so the first frame is bounded regardless of length. Two rules keep that pass and the live/reconcile tail sync from interfering:

- An append (rows arriving from a live turn or a reconcile sync) writes at the **bottom**, so it never competes with the backfill, which inserts **above** the tail at its anchor. The append parks the anchor for the duration of its own writes and hands it back afterwards — `transcriptInsert()` targets that anchor while it is set.
- Because of that, an append does **not** cancel the in-flight backfill. Cancelling it would drop every history row the pass had not reached yet: they would stay in `state.messages` but never reach the DOM, leaving a hole in the middle of the transcript until some later full rebuild. A full rebuild still supersedes the pass, since it re-owns the whole transcript.

## Implementation notes

When a known cost is appended to an assistant message, the same write path increments `chat_store.total_cost` and the registered project's `totalCost`. Clearing, replacing, or deleting transcript data applies the inverse delta. `GET /api/chats` applies `offset` and `limit` in SQLite, uses a separate indexed count for `total`, and never aggregates `message_store`; a one-time migration backfills existing histories. The transcript cursor (`seq`) keeps the paginated view and the append-only tail sync in agreement.

## Related

- [Chat storage](./chat-storage.md) — SQLite-backed messages.
- [Chat UI](./chat-ui.md) — the transcript shell.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
- [Chat backward pagination](./chat-backward-pagination.md) — windowed loading of long transcripts.
