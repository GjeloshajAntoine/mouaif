# Project card

## Overview

The Project card is the per-project surface in the mobile UI: each registered project gets a card with its name, its chat list, a "New chat" button, and an options menu (rename / unregister). The chat list scrolls **inside the card** so the page itself doesn't scroll. The card is the building block the agent-instructions rule describes as "the chat list scrolls inside the card, not the page" and "Project card have new chat and per-project options."

Chats are persisted per-project in `<projectDir>/.mouaif.json` under a `chats` array, alongside the rest of the project-level settings. That means a project's chats can be committed to source control with the project. The chat record itself is a thin entry — `{ id, title, createdAt, lastOpenedAt, trace, promptSize }`; transcripts live separately in `<projectDir>/.mouaif.messages.<chatId>.json`.

New chats inherit `promptSize` from project-level settings via `settings.getResolved(projectDir)` (decisions §2: defaults → app → project). Tracing always starts off unless the creation request explicitly opts in.

## Usage

### HTTP

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/projects/registered` | — | `{ projects: [{ id, path, name, createdAt }] }` |
| PATCH  | `/api/projects/registered/:id` | `{ name }` | `{ project }` (400 on empty/whitespace, 404 on unknown) |
| DELETE | `/api/projects/registered/:id` | — | `{ ok: true }` (folder on disk is NOT touched) |
| GET    | `/api/chats?projectDir=<abs>` | — | `{ chats: [...] }` |
| GET    | `/api/chats/:id?projectDir=<abs>` | — | `{ chat }` or 404 |
| POST   | `/api/chats` | `{ projectDir, title?, trace?, promptSize? }` | `{ chat }` (201) |
| PATCH  | `/api/chats/:id` | `{ projectDir, title?, trace?, promptSize? }` | `{ chat }` (404 if unknown) |
| POST   | `/api/chats/:id/touch` | `{ projectDir }` | `{ chat }` (bumps `lastOpenedAt`) |
| DELETE | `/api/chats/:id?projectDir=<abs>` | — | `{ ok, removed }` (404 if unknown) |

Examples:

````bash
# Rename a project label.
curl -X PATCH http://localhost:5732/api/projects/registered/<id> \
  -H 'Content-Type: application/json' \
  -d '{"name":"My project"}'

# Create a chat.
curl -X POST http://localhost:5732/api/chats \
  -H 'Content-Type: application/json' \
  -d '{"projectDir":"/path/to/project","title":"Refactor auth","trace":true}'

# Rename a chat.
curl -X PATCH http://localhost:5732/api/chats/<id> \
  -H 'Content-Type: application/json' \
  -d '{"projectDir":"/path/to/project","title":"Auth module refactor"}'

# Delete a chat.
curl -X DELETE 'http://localhost:5732/api/chats/<id>?projectDir=/path/to/project'
````

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

- A header: project name (left), options menu (right) — a `⋯` button that opens a small popover with **Rename…** and **Unregister** (red, danger style).
- The on-disk path, in muted monospace, below the name.
- A chat list scroller (`max-height: 160px`, `overflow-y: auto`) so the page itself doesn't scroll. Each item is the chat title (or `New chat` when the user hasn't renamed it), a `<friendly promptSize label> · <smart date> [· trace]` meta line, and a `×` delete button. The list is sorted by `lastOpenedAt` descending (ties and never-opened chats fall back to `createdAt`); the raw `promptSize` id is mapped to its friendly label (`Very small` / `Average` / `Extensive`) so the wording matches the chat view's meta line. The date is a smart short format: time only on the same day, `Mon D` for the same year, `Mon D, YYYY` for older chats; a `new · ` prefix is added when the chat was never opened. The `· trace` segment is appended (and the meta colored amber) when the chat's per-chat trace-to-file toggle is on.
- A "+ New chat" button at the bottom of the card.

The cards are rendered in the order returned by `/api/projects/registered`. The panel has a Refresh button that re-fetches the list.

## Behavior

- **Chats inherit prompt size only.** A new chat's `promptSize` defaults to the resolved project's `promptSize` (or `average` if unset). Its `trace` flag defaults to `false`; the caller may explicitly pass `trace: true` on `POST /api/chats`.
- **Chat ids are 8 hex characters** (`crypto.randomBytes(4).toString('hex')`). The probability of collision within a single project is small enough to ignore for a per-project chat list; a future commit can switch to a longer id if it becomes a real concern.
- **Unregister does not delete the folder.** It removes the project from the app-level `projects` array; the on-disk `<projectDir>/.mouaif.json` and any chats in it are preserved. Re-registering the same folder brings the project back, but the chats are a separate data source (the project file) and the chat list is recomputed from the file.
- **The chat list scrolls inside the card, not the page.** `max-height: 160px; overflow-y: auto` on the inner `<ul>`. Long chat lists do not push the page; the page stays put.
- **The chat list is sorted by recency.** Most-recently-opened chat first; ties and never-opened chats fall back to `createdAt`. The raw `promptSize` id is mapped to its friendly label (`Very small` / `Average` / `Extensive`) so the wording matches the chat view's meta line; an unknown id is shown as-is so a deleted profile still renders something.
- **Tapping `+ New chat` navigates straight into the new chat.** The previous behavior was to refresh the in-card list and leave the user to tap again. The create handler now calls `nav('chat/<id>?projectDir=...')` on the 201 response so the primary action is one tap. If the server doesn't return a chat record, the handler falls back to a list refresh.
- **Empty chats list is actionable copy.** When a project has no chats, the placeholder text is `No chats yet. Tap "+ New chat" below to start one.` so the user can see the primary action without scanning.
- **Project rename is a label only.** It updates the `name` field in the registered-projects array; the on-disk folder name is not touched. The display name in the card updates immediately on success; the project list refetches on the next Refresh.
- **Chat delete is irreversible.** The server returns 200 with `{ ok: true, removed: <id> }`; the client removes the row from the list. A second DELETE on the same id returns 404.

## Implementation notes

- Chats module: [src/chats.js](../../src/chats.js). Public surface: `listChats`, `getChat`, `createChat`, `updateChat`, `deleteChat`, `touchChat`, plus `PROJECT_FILE` and the `newChatId` helper (exported for tests).
- Server wiring: [src/index.js](../../src/index.js) → `handleChats()`. New routes mounted under `/api/chats` and `/api/chats/:id` (with `/touch` and `/:projectDir` variants). The project-card commit also adds `PATCH /api/projects/registered/:id` to support the rename option.
- Project rename: [src/projects.js](../../src/projects.js) → `renameProject(pid, newName)`. Trims and validates. Returns `null` on empty name or unknown id.
- Settings: chat `id` is 8 hex; `lastOpenedAt` is ISO 8601; `promptSize` is one of `very-small | average | extensive`; `trace` is a boolean. All other fields in the chat object are silently dropped on read (defense against corrupted files).

## Related

- Storage: [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
- Folder picker: [docs/features/folder-picker.md](./folder-picker.md).
- Chat transcripts and trace-to-file behavior are documented in [Chat UI](./chat-ui.md).
