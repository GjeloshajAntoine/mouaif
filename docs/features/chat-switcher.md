# Chat switcher

## Overview

The chat switcher is a dropdown in the chat header that lets the user quickly switch between chats in the current project without going back to the project list. A click on the chat title area (including a right-facing arrow chevron) opens a scrollable list of recent chats.

## Usage

1. While viewing a chat, tap or click the chat title area in the header.
2. A dropdown appears showing the most recent 50 chats for the current project.
3. Tap any chat row to navigate to that chat.
4. The currently active chat is highlighted with the accent color.
5. Tap outside the dropdown or click the title again to close it.

Two small side arrows (`‹` and `›`) flank the chat title to visually suggest switching between chats. They fade in on hover.

## Implementation notes

- **Location**: `src/web/src/components/chat/Chat.jsx` (JSX), `src/web/src/components/chat/useChatState.js` (state + actions), `src/web/src/chat.css` (styles).
- The switcher fetches the chat list from `GET /api/chats?projectDir=...&offset=0&limit=50` on open — no pre-loading.
- State uses React `useState` (`chatSwitcherOpen`, `chatSwitcherList`) so the component re-renders on toggle.
- Outside-click handling is wired in the existing `onDocClick` event listener inside `useChatState.js`.
- Navigation is done via `nav()` from `router.js`, which sets `window.location.hash`.
- The dropdown is absolutely positioned below the trigger, uses `max-height: 60vh` with overflow scroll, and sits above the chat content via `z-index: 10`.
- The "No other chats" empty state is shown when the list is empty.