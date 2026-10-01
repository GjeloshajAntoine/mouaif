# Chat backward pagination

## Overview

Opening a long, tool-heavy chat no longer blocks on a full transcript transfer. The chat loads only the newest page of messages, pins to the bottom, and then **eagerly fetches every older page in the background** until the whole transcript is in memory. The first screen (and the head summary, which previously iterated every message) is usable immediately on chats with hundreds of rows, and the user can scroll to any point without waiting for a per-page load.

## Usage

No user-visible control — the behavior is automatic.

- On open, the client fetches `GET /api/chats/:id/messages?limit=100` and paints the newest page, pinned to the bottom.
- Immediately after that first page paints, the client keeps fetching older pages (`beforeSeq` windows) in the background and prepends them above the loaded content, preserving the reading position, until the entire transcript is resident.
- If a turn is running or the chat changes mid-load, the background drain stops; a manual scroll to the top still falls back to loading a page on demand.
- Reaching the very first message sets a "no more" state and stops further requests.

The transcript cursor is the same stable per-chat `seq` used by the append-only tail sync, so the paginated view and the streaming/append path never disagree.

## Scroll stability

Scrolling up while older pages load keeps the rows you are reading in place on every browser, including iPhone and iPad:

- **Pages land between swipes.** A fetched page waits until no finger is on the transcript and no scroll event has fired for 160 ms, capped at 3 s so loading cannot stall. The compensating `scrollTop` write therefore never cancels an iOS momentum fling mid-swipe.
- **No placeholder jumps without scroll anchoring.** Off-screen row skipping (`content-visibility: auto`) is enabled only where the browser supports CSS scroll anchoring (`@supports (overflow-anchor: auto)`). WebKit (Safari and every iOS browser) has no scroll anchoring. There a skipped row snapped from its 120 px placeholder to its real height as it scrolled into view, which pushed the rows being read down on almost every step. Those engines now lay out every row.
- **No entry animation for history.** Rows inserted above the viewport by a page prepend or the chunked open-time backfill get an `is-backfilled` class that disables the bubble-in animation. That saves compositor work in the middle of a scroll, for rows the user never sees arrive.

## Related

- [Chat load performance](./chat-load-performance.md) — the earlier load-time work (cost aggregation, revision cursor, lazy tool results).
- [Chat UI](./chat-ui.md) — the transcript shell and `/messages` endpoint.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
