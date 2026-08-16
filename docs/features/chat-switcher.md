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
