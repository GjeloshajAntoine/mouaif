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
- **+ New chat button** — creates a fresh conversation and navigates directly into it.

## Behavior

- **Independent scrolling** — each card's chat list scrolls internally to prevent tall chat lists from pushing the rest of your dashboard out of view. Vertical overscroll is contained so reaching the first or last chat does not move the dashboard behind the list.
- **Compact height** — the project name and path share one compact header row, while its options menu retains a touch-safe target. The per-card chat list is capped at `10.0625rem` (161px), keeping about three rows visible before the list scrolls. The cap is applied with `max-height`; a `min-height` does not constrain a populated list and was the reason the previous size fix had no effect on normal phone viewports.
- **Recency sorting** — recently opened conversations stay pinned to the top of the card.
- **Cost tracking** — running costs are aggregated per chat and shown directly in the list.

## Implementation notes

The chat list is a `<ul class="project-card__chats">` with a fixed CSS cap — no JS measurement is needed. The card itself is a flex column, so the `<ul>` sits at the bottom and scrolls inside its own box. `overscroll-behavior-y: contain` keeps an edge gesture in the list instead of chaining it to `.app__main`.

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