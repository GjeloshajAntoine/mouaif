# Chat backward pagination

## Overview

Opening a long, tool-heavy chat no longer transfers and renders the *entire* transcript up front. The chat loads only the newest page of messages; older messages are fetched on demand as the user scrolls to the top. This makes the first screen (and the head summary, which previously iterated every message) usable immediately on chats with hundreds of rows.

## Usage

No user-visible control — the behavior is automatic.

- On open, the client fetches `GET /api/chats/:id/messages?limit=100` and paints the newest page, pinned to the bottom.
- Scrolling to the top of the transcript loads the previous page of `limit` rows. Rows are inserted above the loaded content and the reading position is preserved.
- Reaching the very first message sets a "no more" state and stops further requests.

The transcript cursor is the same stable per-chat `seq` used by the append-only tail sync, so the paginated view and the streaming/append path never disagree.

## Implementation notes

**Server-side windowed fetch.** `src/chatdb.js` adds `listMessagesWindow(projectDir, chatId, { limit, beforeSeq })`, which returns the `limit` rows strictly below `beforeSeq` in chronological order. `src/messages.js` re-exports it alongside a `getMessageCount`. `GET /api/chats/:id/messages` now accepts two modes on one URL:

- **Tail mode** (unchanged, the stream/recovery hot path): `fromSeq` returns rows `seq >= fromSeq` plus `nextSeq`.
- **Window mode** (new, chat pagination): `limit` (and optional `beforeSeq`) returns `{ messages, total, hasMore, beforeSeq, nextSeq, base }`. `hasMore` is true when an older page exists; `beforeSeq` is the smallest seq on the page, i.e. the exclusive upper bound for the next older page.

**Client cursor.** `frontend/src/components/chat/pagination.js` holds a small per-chat cursor (`offset`, `beforeSeq`, `hasMore`, `loading`, `total`, `firstSeq`) and the pure decision helper `shouldLoadOlder(pager, scrollTop)`. It is seeded from the first windowed page and advanced by each load. The scroll-up loader in `useChatState.js` calls `shouldLoadOlder` on the transcript scroll listener; `loadOlderMessages` in `stream.js` fetches the next page, dedupes by seq, prepends it via `prependOlderTranscript` in `transcript.js`, and keeps `state.messages` in sync so a later rebuild does not wipe the loaded history.

**Scroll preservation.** `prependOlderTranscript` inserts rows before the first non-header content node, suppresses per-row pinning while filling, then bumps `scrollTop` by exactly the height delta so the rows the user was reading stay in place.

## Related

- [Chat load performance](./chat-load-performance.md) — the earlier load-time work (cost aggregation, revision cursor, lazy tool results).
- [Chat UI](./chat-ui.md) — the transcript shell and `/messages` endpoint.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
