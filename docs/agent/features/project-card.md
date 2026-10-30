# Project card — implementation notes

> Agent-facing reference for [`docs/features/project-card.md`](../../features/project-card.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## On-disk shape

A project's chats metadata is stored in `<projectDir>/.mouaif.json` (or database when DB storage is enabled):

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

### HTTP

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/projects/registered` | — | `{ projects: [{ id, path, name, createdAt }] }` |
| PATCH  | `/api/projects/registered/:id` | `{ name }` | `{ project }` (400 on empty/whitespace, 404 on unknown) |
| PUT    | `/api/projects/registered/order` | `{ ids: [id, ...] }` | `{ projects }` in the new order (400 unless `ids` is an array of strings) |
| DELETE | `/api/projects/registered/:id` | — | `{ ok: true }` (folder on disk is NOT touched) |
| GET    | `/api/chats?projectDir=<abs>[&filter=draft\|recurring]` | — | `{ chats: [..., totalCost: { total, known, currency }] }` |
| GET    | `/api/chats/:id?projectDir=<abs>` | — | `{ chat }` or 404 |
| POST   | `/api/chats` | `{ projectDir, title?, trace?, promptSize?, promptId? }` | `{ chat }` (201; 400 for unknown `promptId`) |
| PATCH  | `/api/chats/:id` | `{ projectDir, title?, trace?, promptSize?, promptId? }` | `{ chat }` (400 for unknown `promptId`; 404 if chat is unknown) |
| POST   | `/api/chats/:id/touch` | `{ projectDir }` | `{ chat }` (bumps `lastOpenedAt`) |
| DELETE | `/api/chats/:id?projectDir=<abs>` | — | `{ ok, removed }` (404 if unknown) |

Examples:

````bash
curl -X PATCH http://localhost:5732/api/projects/registered/<id> \
  -H 'Content-Type: application/json' \
  -d '{"name":"My project"}'

curl -X POST http://localhost:5732/api/chats \
  -H 'Content-Type: application/json' \
  -d '{"projectDir":"/path/to/project","title":"Refactor auth","trace":true}'

curl -X PATCH http://localhost:5732/api/chats/<id> \
  -H 'Content-Type: application/json' \
  -d '{"projectDir":"/path/to/project","title":"Auth module refactor"}'

curl -X DELETE 'http://localhost:5732/api/chats/<id>?projectDir=/path/to/project'
````

## Implementation notes

- **Prompt quick launch** — `frontend/src/components/Projects.jsx` loads the project's merged prompts with its chats. Prompts whose `showOnProjectCard` flag is true render as touch-safe icon buttons beside **+ New chat** and submit their `promptId` during chat creation. Chat rows resolve the same prompt to display its icon.
- **Contained chat-list scrolling** — `.project-card__chats` uses a `10.0625rem` (161px) `max-height` so about three rows remain visible before the list scrolls. `-webkit-overflow-scrolling: touch`, `overscroll-behavior-y: contain`, and `touch-action: pan-y` make the list own vertical gestures without chaining edge scrolls to the dashboard. A previous `min-height` change was ineffective because it did not cap populated lists.
- Chats module: [src/chats.js](../../../src/chats.js). Public surface: `listChats`, `getChat`, `createChat`, `updateChat`, `deleteChat`, `touchChat`, `chatTotalCost`, plus `PROJECT_FILE`. Each `chat_store` row persists `total_cost` and `cost_known_count`; assistant-message writes update those columns and the registered project's `totalCost` by delta. `GET /api/chats` returns the stored chat summary without reading `message_store`.
- Server wiring: [src/index.js](../../../src/index.js) → `handleChats()`. New routes mounted under `/api/chats` and `/api/chats/:id` (with `/touch` and `/:projectDir` variants). The project-card commit also adds `PATCH /api/projects/registered/:id` to support the rename option.
- Project rename: [src/projects.js](../../../src/projects.js) → `renameProject(pid, newName)`. Trims and validates. Returns `null` on empty name or unknown id.
- Settings: chat `id` is 8 hex; `lastOpenedAt` is ISO 8601; `promptSize` is one of `very-small | average | extensive`; `trace` is a boolean. All other fields in the chat object are silently dropped on read (defense against corrupted files).

The chat list is a `<ul class="project-card__chats">` with a fixed CSS cap — no JS measurement is needed. The card itself is a flex column, so the `<ul>` sits at the bottom and scrolls inside its own box. `overscroll-behavior-y: contain` keeps an edge gesture in the list instead of chaining it to `.app__main`.

Draft-only detection uses `messageCount === 0` (a bulk `GROUP BY` over `message_store` in `src/chatdb.js#projectMessageCounts`, attached per-page by `GET /api/chats` in `src/server-handlers-chats.js`) combined with a non-empty `draftSnippet` — or, for a draft that holds only a picture, `hasDraftImage`. A running chat is never treated as draft-only even if it has no stored message yet, because the blue running indicator takes precedence.

List rows are summaries, not full chat records: `GET /api/chats` replaces the `draft` body with `draftSnippet` (its first 400 characters) and the `draftAttachments` array with the `hasDraftImage` flag, so a page never carries the base64 of a pending picture (see [Chat load performance](../../features/chat-load-performance.md)). Read the whole draft through `GET /api/chats/:id`.

```css
.project-card__chats {
  max-height: 10.0625rem;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
  touch-action: pan-y;
}
```

## Layout notes

- `.project-card` has no `overflow: hidden`. The `⋯` popover (`.project-card__menu-pop`, about 146 px tall) hangs below the 44 px header, and a card with 0–2 chats is shorter than that. The bottom corners are rounded by `.project-card__new-actions` (`border-radius: 0 0 var(--r-md) var(--r-md)`) instead.
- Each card gets an entrance animation (`.projects__list > li`, `fill-mode: both`), which leaves it in its own stacking context. `.project-card:has(.project-card__menu-btn[aria-expanded="true"])` sets `position: relative; z-index: 2` so the open menu paints over the next card.
- The empty / loading / "more" rows are `li.project-card__chats-empty` and `li.project-card__chats-more`. The `li.` prefix is needed: the generic `.project-card__chats li` row rules (flex, padding, hover tint) would otherwise win on specificity.
- Regression test: `scripts/test-project-card-chrome.mjs` (fixture-rendered `ProjectsView`, 360–430 px).

## Reordering

- **Order is the array order.** The registered projects live in the app setting `projects`; `GET /api/projects/registered` returns them in that order and `ProjectsView` renders them in it. `projects.reorderProjects(ids)` puts the listed ids first (unknown ids and repeats ignored), keeps every unlisted project after them in its old relative order, and writes nothing when the order is unchanged. A client with a stale list therefore cannot drop a project that was added elsewhere.
- **Gesture.** `frontend/src/hooks/useLongPressReorder.js`: pointer events on `.project-card__head`, a 400 ms hold (`HOLD_MS`) with an 8 px slop (`HOLD_SLOP_PX`) — more movement than that before the hold fires hands the gesture back to the browser as a scroll. Presses that start inside `.project-card__menu` or on a button/link are ignored. Once the hold fires the hook adds a non-passive `touchmove` listener that cancels the scroll (this is what keeps the pointer stream from being cancelled by the browser's pan), and `contextmenu` is cancelled on the header.
- **Drag is DOM-only.** The cards move with the CSS `translate`/`scale` properties, not `transform`, because the card entrance animation animates `transform` with `fill-mode: both` and would override an inline `transform`. State is not touched while dragging; `onReorder(ids)` runs once on drop, after a 150 ms settle animation, and the translates are cleared two frames after the re-render.
- **Slot is chosen by the finger**, not by the lifted card's middle (`reorderedIds`): the cards are tall and held by the header.
- **Scrolling.** The app scrolls `.app__main`, not the window, so the hook finds the nearest vertical scroller (`scrollerOf`) and works in its content coordinates; within 72 px of its top or bottom edge it scrolls by up to 14 px per frame.
- **Save.** `ProjectsView.commitOrder` reorders the list at once, `PUT`s the ids and, if the response is not 200, reloads the list (`loadProjects`). `loadProjects` does nothing while a drag is active.
- **Menu route.** `Move up` / `Move down` in `ProjectMenu` call the same `commitOrder` and announce through the status line (`aria-live`).
- Tests: `scripts/test-project-reorder.js` (store, route), `scripts/test-project-reorder-ui.mjs` (mouse and touch drag, tap, early move, Escape, auto-scroll, menu, failed save).
