# Project card search

## Overview

Every project card on the Chats tab has a magnifier button. Tapping it opens a search field that narrows that project's chats to the ones matching what you type — matching the chat title, the text of messages you already sent or received, and the text still sitting in a chat's composer draft.

## Usage

1. On the **Chats** tab, find the project card you want to search.
2. Tap the magnifier at the right end of the card's action row, next to **+ New chat**.
3. Type a word or phrase. Results appear under the field as you stop typing.
4. Tap a result to open that chat. Tap **×** inside the field, tap the magnifier again, or press `Escape` to leave search and get the normal chat list back.

Only the card you searched changes; every other project card keeps its own list.

## Behavior

- **What is searched** — the chat title, every stored message of the chat, and the composer draft. A chat appears once even when all three match.
- **Match label** — a result whose title matched shows nothing extra. A result that matched in a message shows a `TEXT` badge and a one-line preview of the matching message; a draft match shows a `DRAFT` badge and the start of the draft.
- **Results are the project's most recent matches**, in the same order as the card's normal chat list.
- **Only a settled term is sent.** Typing is not a request per keystroke, and the previous term's results are never shown against a new term.
- **No match is not an error** — the card says the term matched nothing. A request that actually failed says so instead.
- **Search is per project card and per session.** Closing the field clears the term, the results, and any error; reopening starts empty.

## Related

- [Project card](./project-card.md) — the chat list, **+ New chat**, and the project options menu that this button sits beside.
- [Chat switcher](./chat-switcher.md) — switching between chats of the current project from inside a chat.
- [Chat UI](./chat-ui.md) — the conversation view a result opens.
