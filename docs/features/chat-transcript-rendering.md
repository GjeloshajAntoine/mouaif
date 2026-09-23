# Chat transcript rendering

## Overview

The chat transcript reuses the DOM rows that are already on screen instead of destroying and rebuilding them on every render pass. A row whose identity has not changed keeps its element; a header card whose inputs have not changed keeps its node. A pass over unchanged data therefore performs no DOM mutation at all, which is what stops the transcript from flashing.

## Usage

No user-visible controls — the behavior is automatic. Open a chat, send a message, or leave an idle chat on screen: rows appear and update in place, and the conversation area no longer blinks between paints.

## Behavior

- **Rows are reused, not rebuilt** — a row keeps its element while its identity is unchanged, so nothing replays the entry animation.
- **Tool-card lookups are indexed** — resolving a card by tool id and recovering a result row's call arguments are constant-time, rather than a DOM walk and a transcript scan per row. This is what keeps a redraw of a tool-heavy chat proportional to the number of rows instead of to its square.
- **Off-screen rows are skipped** — a long transcript's rows that are nowhere near the viewport are not laid out or painted, with a placeholder height so the scrollbar does not jump.

## Related

- [Chat UI](./chat-ui.md) — the Preact + Vite shell that hosts the transcript.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
- [Chat load performance](./chat-load-performance.md) — latest-first rendering and the incremental tail sync.
- [Chat backward pagination](./chat-backward-pagination.md) — windowed loading of long transcripts.

