# Chat scroll navigation — implementation notes

> Agent-facing reference for [`docs/features/chat-scroll-nav.md`](../../features/chat-scroll-nav.md). The human-facing surface lives in that file; the implementation details and source paths live here.

## Implementation

- Markup lives in `frontend/src/components/chat/Chat.jsx` (`nav.chat-view__scroll-nav`). The Bottom arrow is the old jump-to-bottom button (`refs.jumpBtn`, `.chat-view__jump`), so its counter logic is the same.
- `updateJumpButton(refs)` in `frontend/src/components/chat/scroll.js` changes the rail's `data-mode` (`pinned` / `free`) and its visibility directly on the DOM, so scrolling never re-renders Preact. `noteTranscriptScrollTop(refs, scrollTop)` reuses the `scrollTop` the scroll listener has already read to decide whether the transcript overflows. It adds no layout read.
- `scrollToAdjacentMessage(refs, dir)` reads row positions only when an arrow is tapped. The rail sits outside the transcript, so the user-intent tracker cannot see the tap. The function therefore unpins on its own and cancels any pending re-pin, which stops the scroll listener from pulling the view back down. Off-screen rows use `content-visibility: auto` placeholders, so the function lines the row up again for up to three frames as the real layout arrives.
- `findAdjacentMessage(tops, line, dir)` is the pure lookup, covered by `scripts/test-chat-scroll-nav.mjs` (part of `npm run test:chat-view`).
