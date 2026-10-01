# Chat scroll navigation — implementation notes

> Agent-facing reference for [`docs/features/chat-scroll-nav.md`](../../features/chat-scroll-nav.md). The human-facing surface lives in that file; the implementation details and source paths live here.

## Implementation

- Markup lives in `frontend/src/components/chat/Chat.jsx` (`nav.chat-view__scroll-nav`). The Bottom arrow is the old jump-to-bottom button (`refs.jumpBtn`, `.chat-view__jump`), so its counter logic is the same.
- `updateJumpButton(refs)` in `frontend/src/components/chat/scroll.js` changes the rail's `data-mode` (`pinned` / `free`) and its visibility directly on the DOM, so scrolling never re-renders Preact. `noteTranscriptScrollTop(refs, scrollTop)` reuses the `scrollTop` the scroll listener has already read to decide whether the transcript overflows. It adds no layout read.
- `scrollToAdjacentMessage(refs, dir)` reads row positions only when an arrow is tapped. The rail sits outside the transcript, so the user-intent tracker cannot see the tap. The function therefore unpins on its own and cancels any pending re-pin, which stops the scroll listener from pulling the view back down. Off-screen rows use `content-visibility: auto` placeholders, so the function lines the row up again for up to three frames as the real layout arrives.
- `findAdjacentMessage(tops, line, dir)` is the pure lookup, covered by `scripts/test-chat-scroll-nav.mjs` (part of `npm run test:chat-view`).
- The rail lives in `.chat-view__transcript-box`, a positioned wrapper that takes the transcript's flex slot. The rail's `bottom` is measured from the transcript itself, not a fixed offset from the bottom of the chat view.
- A single tap always moves the view by at least 48 px, which is the `isNearBottom()` pin threshold. Without that floor, "previous" at the bottom picked the row cut off a few pixels above the top edge. The tap then barely moved the view, landed back inside the pin band, and re-pinned straight away, so the arrow looked dead.
- "Next" re-pins when the next row can never reach the top, because the view is already scrolled as far as it goes. The rail then returns to its pinned state, rather than unpinning with nothing left to scroll.
- Transcript rows have `flex-shrink: 0`. The transcript is a height-bounded flex column, and an off-screen `content-visibility: auto` row has a min-content height of 0. Shrinkable rows therefore collapsed to nothing, which broke both the scrollbar and the row offsets the arrows jump to.
- `node scripts/chat-scroll-nav-fixture.mjs [port]` serves the real chat view with a long fake transcript and in-page API stubs. Open it at a phone viewport to check the arrows by hand.

### Layout constraints the rail depends on

The bottom offset, the 48 px floor and `flex-shrink: 0` are all layout contracts rather than styling choices: change any of them and an arrow either sits on the composer, reads as dead, or jumps to the wrong row. The fixture above is the way to re-check them by hand after touching the transcript's box model.
