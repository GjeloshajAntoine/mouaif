# Chat switcher — implementation notes

> Agent-facing reference for [`docs/features/chat-switcher.md`](../../features/chat-switcher.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- **Location**: `frontend/src/components/chat/Chat.jsx` (JSX), `frontend/src/components/chat/useChatState.js` (state + actions), `frontend/src/chat-view.css` (styles).
- **Preloading**: the list is fetched from `GET /api/chats?projectDir=...&offset=0&limit=100` in a `useEffect` that runs on mount and whenever the current chat or its running state changes. The dropdown opens with cached rows — no fetch on open.
- **Pagination**: a single `chatSwitcherPager` ref (`{ projectDir, offset, total, loading }`) is shared by the preload effect and the scroll handler so both advance one footer. The preload starts at `offset 0`; scrolling near the bottom of the dropdown fetches the next page beginning at the current `offset` (advancing by the page size, up to 100) and appends it, deduplicating by chat id. Each project refresh creates a new pager identity, and async callbacks update the UI only while that exact pager remains current, preventing a response from a previous project from changing the active project's list or loading state. The server `total` is recorded from the first response so the guard knows when every row is loaded. A "Loading more…" footer is shown while a page is in flight. The offset/total live in the ref — not in DOM `data-*` attributes (which the JSX initialized statically and the scroll guard misread as "all loaded"), so chats beyond the first 100 are reachable by scrolling.
- **Streaming indicator**: the current chat's row shows a pulsing accent dot while `runningVisible` is true (the same state that swaps the send button for the stop button). The preload refresh on running-state change also clears stale `running` flags from the list.
- State uses React `useState` (`chatSwitcherOpen`, `chatSwitcherList`) so the component re-renders on toggle.
- Outside-click handling is wired in the existing `onDocClick` event listener inside `useChatState.js`.
- Navigation is done via `nav()` from [frontend/src/router.js](../../../frontend/src/router.js), which sets `window.location.hash`; the hash → view table itself is [frontend/src/routes.js](../../../frontend/src/routes.js).
- The dropdown is absolutely positioned below the trigger, uses `max-height: 60vh` with overflow scroll, and sits above the chat content via `z-index: 10`.
- The "No other chats" empty state is shown when the list is empty.
