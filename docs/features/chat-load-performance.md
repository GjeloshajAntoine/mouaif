# Chat load performance

## Overview

Opening a long, tool-heavy chat should feel instant even when the transcript runs to hundreds of messages and multiple megabytes. This page documents the server-side and client-side changes that keep chat load fast: SQL-side cost aggregation, a cheap transcript revision marker for polling, and lazy rendering of collapsed tool-result cards.

## Usage

No user-visible controls — the behavior is automatic. Open any chat (especially a long agentic one) and it paints progressively; the 1-second reconcile poll and the post-stream reconciliation no longer re-download the whole transcript unless something actually changed — and when it did, they transfer only the rows appended after the client's known prefix.

## Related

- [Chat storage](./chat-storage.md) — SQLite-backed messages.
- [Chat UI](./chat-ui.md) — the transcript shell.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
