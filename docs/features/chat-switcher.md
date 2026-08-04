# Chat switcher

## Overview

The chat switcher is a dropdown in the chat header that lets the user quickly switch between chats in the current project without going back to the project list. A click on the chat title area (including a right-facing arrow chevron) opens a scrollable, paginated list of recent chats. The list is preloaded when the chat view mounts, so opening the dropdown never waits on the network, and the currently running chat is marked with a pulsing dot while a response is streaming.

## Usage

1. While viewing a chat, tap or click the chat title area in the header.
2. A dropdown appears instantly, showing the project's recent chats (already loaded in the background).
3. Tap any chat row to navigate to that chat.
4. The currently active chat is highlighted with the accent color and shows a pulsing dot while a response is streaming in it.
5. Scroll the dropdown to the bottom to load older chats (100 per page).
6. Tap outside the dropdown or click the title again to close it.

A small down-chevron (`▾`) sits to the right of the chat title; it flips to `▴` (via CSS `rotate(180deg)`) when the dropdown is open.

## Implementation notes

- **Location**: `src/web/src/components/chat/Chat.jsx` (JSX), `src/web/src/components/chat/useChatState.js` (state + actions), `src/web/src/chat-view.css` (styles).
- **Preloading**: the list is fetched from `GET /api/chats?projectDir=...&offset=0&limit=100` in a `useEffect` that runs on mount and whenever the current chat or its running state changes. The dropdown opens with cached rows — no fetch on open.
- **Pagination**: scrolling near the bottom of the dropdown fetches the next page (`offset` advances by 100) and appends it, deduplicating by chat id. A "Loading more…" footer is shown while a page is in flight; the API caps pages at 100 rows, so chats beyond that are reached by scrolling.
- **Streaming indicator**: the current chat's row shows a pulsing accent dot while `runningVisible` is true (the same state that swaps the send button for the stop button). The preload refresh on running-state change also clears stale `running` flags from the list.
- State uses React `useState` (`chatSwitcherOpen`, `chatSwitcherList`) so the component re-renders on toggle.
- Outside-click handling is wired in the existing `onDocClick` event listener inside `useChatState.js`.
- Navigation is done via `nav()` from `router.js`, which sets `window.location.hash`.
- The dropdown is absolutely positioned below the trigger, uses `max-height: 60vh` with overflow scroll, and sits above the chat content via `z-index: 10`.
- The "No other chats" empty state is shown when the list is empty.
