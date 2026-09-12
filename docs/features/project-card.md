# Project card

## Overview

The Project card is the main organizational view in mouaif: each registered project appears as a card displaying the project name, path, list of chats, a "+ New chat" button, and a project options menu.

![Project cards in the Chats tab — registered projects, each with a name, path, chat list, and "+ New chat" button.](./images/project-card/chats-tab.png)

## Card features

- **Project header** — displays the project name and path, with an options menu (`⋯`) offering:
  - **Settings…** — opens the dedicated project settings page.
  - **Rename…** — updates the display name of the project.
  - **Unregister** — removes the project from mouaif without deleting any files on disk.
- **Scrollable chat list** — lists previous conversations sorted by most recently active. Each chat row displays:
- The conversation title.
- Total token cost and timestamp.
- A quick delete (`×`) action.
- **Draft-only chats** — a chat with no persisted messages but a non-empty composer draft renders the start of that draft instead of the title, tinted yellow (`--warning`) with a small yellow rectangle indicator — the inverse of the blue "running" dot. An image-only draft (a pending picture in the composer, no text yet) reads as `Image draft` so the row still shows that something is waiting there.
- **+ New chat button** — creates a fresh conversation and navigates directly into it.
- **Custom prompt buttons** — prompts with **Add to project card** enabled appear as icon buttons beside **+ New chat**. Tapping one creates a chat with that prompt attached; its icon also identifies the prompt on the resulting chat row.

## Behavior

- **Independent scrolling** — each card's chat list scrolls internally to prevent tall chat lists from pushing the rest of your dashboard out of view. Vertical overscroll is contained so reaching the first or last chat does not move the dashboard behind the list.
- **Compact height** — the project name and path share one compact header row, while its options menu retains a touch-safe target. The per-card chat list is capped at `10.0625rem` (161px), keeping about three rows visible before the list scrolls. The cap is applied with `max-height`; a `min-height` does not constrain a populated list and was the reason the previous size fix had no effect on normal phone viewports.
- **Recency sorting** — recently opened conversations stay pinned to the top of the card.
- **Cost tracking** — running costs are aggregated per chat and shown directly in the list.
- **Draft inference** — whether a chat is "draft-only" is decided entirely on the client from fields already in the list payload: `messageCount`, `draftSnippet` and `hasDraftImage`. No additional request is made per row.

## Implementation notes

The chat list is a `<ul class="project-card__chats">` with a fixed CSS cap — no JS measurement is needed. The card itself is a flex column, so the `<ul>` sits at the bottom and scrolls inside its own box. `overscroll-behavior-y: contain` keeps an edge gesture in the list instead of chaining it to `.app__main`.

Draft-only detection uses `messageCount === 0` (a bulk `GROUP BY` over `message_store` in `src/chatdb.js#projectMessageCounts`, attached per-page by `GET /api/chats` in `src/server-handlers-chats.js`) combined with a non-empty `draftSnippet` — or, for a draft that holds only a picture, `hasDraftImage`. A running chat is never treated as draft-only even if it has no stored message yet, because the blue running indicator takes precedence.

List rows are summaries, not full chat records: `GET /api/chats` replaces the `draft` body with `draftSnippet` (its first 400 characters) and the `draftAttachments` array with the `hasDraftImage` flag, so a page never carries the base64 of a pending picture (see [Chat load performance](./chat-load-performance.md)). Read the whole draft through `GET /api/chats/:id`.

```css
.project-card__chats {
  max-height: 10.0625rem;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
  touch-action: pan-y;
}
```

## Related

- [Folder picker](./folder-picker.md) — registering new project directories.
- [App and project settings](./app-and-project-settings.md) — configuring project-specific prompts and tools.
- [Chat UI](./chat-ui.md) — the chat conversation view.