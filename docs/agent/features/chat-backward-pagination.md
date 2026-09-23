# Chat backward pagination — implementation notes

> Agent-facing reference for [`docs/features/chat-backward-pagination.md`](../../features/chat-backward-pagination.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

**Server-side windowed fetch.** `src/chatdb.js` adds `listMessagesWindow(projectDir, chatId, { limit, beforeSeq })`, which returns the `limit` rows strictly below `beforeSeq` in chronological order. `src/messages.js` re-exports it alongside a `getMessageCount`. `GET /api/chats/:id/messages` now accepts two modes on one URL:

- **Tail mode** (unchanged, the stream/recovery hot path): `fromSeq` returns rows `seq >= fromSeq` plus `nextSeq`.
- **Window mode** (new, chat pagination): `limit` (and optional `beforeSeq`) returns `{ messages, total, hasMore, beforeSeq, nextSeq, base }`. `hasMore` is true when an older page exists; `beforeSeq` is the smallest seq on the page, i.e. the exclusive upper bound for the next older page.

**Client cursor.** `frontend/src/components/chat/pagination.js` holds a small per-chat cursor (`offset`, `beforeSeq`, `hasMore`, `loading`, `total`, `firstSeq`) and the pure decision helper `shouldLoadOlder(pager, scrollTop)`. It is seeded from the first windowed page and advanced by each load. The scroll-up loader in `useChatState.js` calls `shouldLoadOlder` on the transcript scroll listener; `loadOlderMessages` in `stream.js` fetches the next page, dedupes by seq, prepends it via `prependOlderTranscript` in `transcript.js`, and keeps `state.messages` in sync so a later rebuild does not wipe the loaded history.

**Eager background drain.** `loadAllOlderMessages` in `stream.js` (fired once from `useChatState.js` right after the first page paints) loops `fetchAndPrependOlderPage` until `hasMore` is false, so older pages arrive without waiting for a scroll to the top. It latches the pagination cursor for the whole run (so the scroll-up loader and the drainer never double-fetch), yields between pages with a `setTimeout(0)` so the browser can paint, and bails early if a turn starts (`streaming`/`watchingRun`), the transcript unmounts, or `state.props` drifts to another chat. The latch-free core `fetchAndPrependOlderPage` is shared by both the single-page loader and the drainer.

**Scroll preservation.** `prependOlderTranscript` inserts rows before the first non-header content node, suppresses per-row pinning while filling, then bumps `scrollTop` by exactly the height delta so the rows the user was reading stay in place.

**Progress vs. existence.** A page's return value reports whether the DOM changed, never whether older history remains. A page can legitimately insert nothing — a reconcile that landed between loads can already hold the rows a page returns — while still advancing `beforeSeq`. Two places used to conflate the two: the pager cleared `hasMore` when a page inserted nothing even though the server had reported more, and the drainer stopped on that `false` return. Together they hid every remaining older page. `hasMore` now comes only from the server's own flag, and the drainer decides from cursor advance: a failed fetch leaves `beforeSeq` untouched (so the drain stops and the next scroll retries), while a no-op page advances it and keeps the drain going. An absent `hasMore` in the response is read as "a cursor exists", not as "false", so legacy responses without the flag cannot latch pagination off.

`scripts/test-chat-pagination-drain.js` covers the no-op page, the empty page, the failed fetch and the single-page loader's return contract; `scripts/test-chat-pagination.js` covers the seeding rules including the absent `hasMore` case.
