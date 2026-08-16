# Project card

## Overview

The Project card is the per-project surface in the mobile UI: each registered project gets a card with its name, its chat list, a "New chat" button, and an options menu (settings / rename / unregister). The chat list scrolls **inside the card** so the page itself doesn't scroll. The card is the building block the agent-instructions rule describes as "the chat list scrolls inside the card, not the page" and "Project card have new chat and per-project options."

Chats are persisted per-project in `<projectDir>/.mouaif.json` under a `chats` array, alongside the rest of the project-level settings. That means a project's chats can be committed to source control with the project. The chat record itself is a thin entry — `{ id, title, createdAt, lastOpenedAt, trace, promptSize }`; transcripts live separately in `<projectDir>/.mouaif.messages.<chatId>.json`.

New chats inherit `promptSize` from project-level settings via `settings.getResolved(projectDir)` (decisions §2: defaults → app → project). Tracing always starts off unless the creation request explicitly opts in.

## Usage

### On-disk shape

A project's chats are stored in `<projectDir>/.mouaif.json` alongside any other project-level settings:

```json
{
  "promptSize": "extensive",
  "chats": [
    {
      "id": "2e5d3d07",
      "title": "Refactor auth",
      "createdAt": "2026-07-14T12:34:00.000Z",
      "lastOpenedAt": null,
      "trace": true,
      "promptSize": "extensive"
    }
  ]
}
```

The `chats` key is created on the first `POST /api/chats` for the project. Reading a project that has no `chats` key returns `[]`. A corrupt project file is surfaced as `422 MOUAIF_PROJECT_PARSE_ERROR` on every chat read, and the UI can recover by re-loading the project after the user fixes the file.

### Mobile UI

The mobile UI shows a "Projects" section between Settings and Auth. Each project renders as a card with:

![Project cards in the Chats tab — two registered projects, each with a name, on-disk path, chat list, and "+ New chat" button.](./images/project-card/chats-tab.png)

- A header: project name (left), options menu (right) — a `⋯` button that opens a small popover with **Settings…**, **Rename…**, and **Unregister** (red, danger style). **Settings…** navigates to the project-settings view (`#/settings/project?projectDir=<abs>`) for that specific project, where the user can review and edit every project setting from structured mobile-first controls — **Prompt size**, the security-sensitive **Shell tool** toggle, and **Custom prompts** — with the raw `.mouaif.json` editor and the resolved (effective) object tucked into a collapsed **Advanced** section for hand-editing.
- The on-disk path, in muted monospace, below the name.
- A chat list scroller (`max-height: 160px`, `overflow-y: auto`) so the page itself doesn't scroll. Each item is the chat title (or `New chat` when the user hasn't renamed it), a `<totalCost> · <smart date> [· trace]` meta line, and a `×` delete button. The list is sorted by `lastOpenedAt` descending (ties and never-opened chats fall back to `createdAt`). The `totalCost` is the running cost of the chat in USD, summed from the per-assistant-message `cost.total` values written by the streaming layer (decision §14); a brand-new chat with no assistant messages yet — or one whose upstream never reported usage — renders as `--` so it doesn't look like the chat cost `$0.00`. The date is a smart short format: time only on the same day, `Mon D` for the same year, `Mon D, YYYY` for older chats; a `new · ` prefix is added when the chat was never opened. The `· trace` segment is appended (and the meta colored amber) when the chat's per-chat trace-to-file toggle is on.
- A "+ New chat" button at the bottom of the card.

The cards are rendered in the order returned by `/api/projects/registered`. The panel has a Refresh button that re-fetches the list.

## Behavior

- **Chats inherit prompt size only.** A new chat's `promptSize` defaults to the resolved project's `promptSize` (or `average` if unset). Its `trace` flag defaults to `false`; the caller may explicitly pass `trace: true` on `POST /api/chats`.
- **Chat ids are 8 hex characters** (`crypto.randomBytes(4).toString('hex')`). The probability of collision within a single project is small enough to ignore for a per-project chat list; a future commit can switch to a longer id if it becomes a real concern.
- **Unregister does not delete the folder.** It removes the project from the app-level `projects` array; the on-disk `<projectDir>/.mouaif.json` and any chats in it are preserved. Re-registering the same folder brings the project back, but the chats are a separate data source (the project file) and the chat list is recomputed from the file.
- **The chat list scrolls inside the card, not the page.** `max-height: 160px; overflow-y: auto` on the inner `<ul>`. Long chat lists do not push the page; the page stays put.
- **The chat list is sorted by recency.** Most-recently-opened chat first; ties and never-opened chats fall back to `createdAt`. The meta line shows the chat's running cost (sum of every assistant message's `cost.total` from decision §14), formatted as `$0.00`–`$0.00012` style with 2–5 fractional digits. A chat with no assistant messages yet — or one whose upstream never reported usage — renders as `--` so the user is never told a brand-new chat cost $0.00.
- **Tapping `+ New chat` navigates straight into the new chat.** The previous behavior was to refresh the in-card list and leave the user to tap again. The create handler now calls `nav('chat/<id>?projectDir=...')` on the 201 response so the primary action is one tap. If the server doesn't return a chat record, the handler falls back to a list refresh.
- **Empty chats list is actionable copy.** When a project has no chats, the placeholder text is `No chats yet. Tap "+ New chat" below to start one.` so the user can see the primary action without scanning.
- **Project rename is a label only.** It updates the `name` field in the registered-projects array; the on-disk folder name is not touched. The display name in the card updates immediately on success; the project list refetches on the next Refresh.
- **Chat delete is irreversible.** The server returns 200 with `{ ok: true, removed: <id> }`; the client removes the row from the list. A second DELETE on the same id returns 404.

## Related

- Storage: [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
- Folder picker: [docs/features/folder-picker.md](./folder-picker.md).
- Chat transcripts and trace-to-file behavior are documented in [Chat UI](./chat-ui.md).
