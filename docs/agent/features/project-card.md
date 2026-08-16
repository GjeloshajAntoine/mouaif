# Project card — implementation notes

> Agent-facing reference for [`docs/features/project-card.md`](../../features/project-card.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### HTTP

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET    | `/api/projects/registered` | — | `{ projects: [{ id, path, name, createdAt }] }` |
| PATCH  | `/api/projects/registered/:id` | `{ name }` | `{ project }` (400 on empty/whitespace, 404 on unknown) |
| DELETE | `/api/projects/registered/:id` | — | `{ ok: true }` (folder on disk is NOT touched) |
| GET    | `/api/chats?projectDir=<abs>` | — | `{ chats: [..., totalCost: { total, known, currency }] }` |
| GET    | `/api/chats/:id?projectDir=<abs>` | — | `{ chat }` or 404 |
| POST   | `/api/chats` | `{ projectDir, title?, trace?, promptSize? }` | `{ chat }` (201) |
| PATCH  | `/api/chats/:id` | `{ projectDir, title?, trace?, promptSize? }` | `{ chat }` (404 if unknown) |
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

- Chats module: [src/chats.js](../../src/chats.js). Public surface: `listChats`, `getChat`, `createChat`, `updateChat`, `deleteChat`, `touchChat`, `chatTotalCost`, plus `PROJECT_FILE` and the `newChatId` helper (exported for tests). `chatTotalCost(projectDir, chatId)` sums every assistant message's `cost.total` and returns `{ total, known, currency }`; `known` is false when no assistant message had a cost block. The GET /api/chats handler attaches the result to each chat as a `totalCost` field so the mobile list can render the cost without a per-chat fetch.
- Server wiring: [src/index.js](../../src/index.js) → `handleChats()`. New routes mounted under `/api/chats` and `/api/chats/:id` (with `/touch` and `/:projectDir` variants). The project-card commit also adds `PATCH /api/projects/registered/:id` to support the rename option.
- Project rename: [src/projects.js](../../src/projects.js) → `renameProject(pid, newName)`. Trims and validates. Returns `null` on empty name or unknown id.
- Settings: chat `id` is 8 hex; `lastOpenedAt` is ISO 8601; `promptSize` is one of `very-small | average | extensive`; `trace` is a boolean. All other fields in the chat object are silently dropped on read (defense against corrupted files).
