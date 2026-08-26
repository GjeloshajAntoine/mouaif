# Chat load performance

## Overview

Opening a long, tool-heavy chat should feel instant even when the transcript runs to hundreds of messages and multiple megabytes. This page documents the server-side and client-side changes that keep chat load fast: SQL-side cost aggregation, a cheap transcript revision marker for polling, and lazy rendering of collapsed tool-result cards.

## Usage

No user-visible controls — the behavior is automatic. Open any chat (especially a long agentic one) and it paints progressively; the 1-second reconcile poll and the post-stream reconciliation no longer re-download the whole transcript unless something actually changed — and when it did, they transfer only the rows appended after the client's known prefix.

Returning to the Chats tab also loads each project's first 30 chat summaries without scanning cost data for older, off-page chats. Active or very large transcripts therefore do not unnecessarily delay the visible project chat list.

## Implementation notes

`GET /api/chats` limits SQLite cost aggregation to the IDs in the requested page. A partial index on assistant messages with cost data keeps this lookup proportional to the visible summaries while preserving the existing response shape and pagination.

## Related

- [Chat storage](./chat-storage.md) — SQLite-backed messages.
- [Chat UI](./chat-ui.md) — the transcript shell.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
