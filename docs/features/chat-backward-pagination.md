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

## Implementation notes

**Server-side windowed fetch.** `src/chatdb.js` adds `listMessagesWindow(projectDir, chatId, { limit, beforeSeq })`, which returns the `limit` rows strictly below `beforeSeq` in chronological order. `src/messages.js` re-exports it alongside a `getMessageCount`. `GET /api/chats/:id/messages` now accepts two modes on one URL:

- **Tail mode** (unchanged, the stream/recovery hot path): `fromSeq` returns rows `seq >= fromSeq` plus `nextSeq`.
- **Window mode** (new, chat pagination): `limit` (and optional `beforeSeq`) returns `{ messages, total, hasMore, beforeSeq, nextSeq, base }`. `hasMore` is true when an older page exists; `beforeSeq` is the smallest seq on the page, i.e. the exclusive upper bound for the next older page.

**Client cursor.** `frontend/src/components/chat/pagination.js` holds a small per-chat cursor (`offset`, `beforeSeq`, `hasMore`, `loading`, `total`, `firstSeq`) and the pure decision helper `shouldLoadOlder(pager, scrollTop)`. It is seeded from the first windowed page and advanced by each load. The scroll-up loader in `useChatState.js` calls `shouldLoadOlder` on the transcript scroll listener; `loadOlderMessages` in `stream.js` fetches the next page, dedupes by seq, prepends it via `prependOlderTranscript` in `transcript.js`, and keeps `state.messages` in sync so a later rebuild does not wipe the loaded history.

**Eager background drain.** `loadAllOlderMessages` in `stream.js` (fired once from `useChatState.js` right after the first page paints) loops `fetchAndPrependOlderPage` until `hasMore` is false, so older pages arrive without waiting for a scroll to the top. It latches the pagination cursor for the whole run (so the scroll-up loader and the drainer never double-fetch), yields between pages with a `setTimeout(0)` so the browser can paint, and bails early if a turn starts (`streaming`/`watchingRun`), the transcript unmounts, or `state.props` drifts to another chat. The latch-free core `fetchAndPrependOlderPage` is shared by both the single-page loader and the drainer.

**Scroll preservation.** `prependOlderTranscript` inserts rows before the first non-header content node, suppresses per-row pinning while filling, then bumps `scrollTop` by exactly the height delta so the rows the user was reading stay in place.

## Related

- [Chat load performance](./chat-load-performance.md) — the earlier load-time work (cost aggregation, revision cursor, lazy tool results).
- [Chat UI](./chat-ui.md) — the transcript shell and `/messages` endpoint.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
