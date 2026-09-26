# Custom prompts — implementation notes

> Agent-facing reference for [`docs/features/custom-prompts.md`](../../features/custom-prompts.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### API

Prompts are managed via REST endpoints on the mouaif server.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/prompts[?projectDir=<abs>][&scope=app\|project]` | List prompts (app, project, or merged) |
| `GET` | `/api/prompts/:id[?projectDir=<abs>][&scope=app\|project]` | Get a single prompt |
| `POST` | `/api/prompts` | Create a prompt. Body: `{ projectDir?, scope?, title?, icon?, showOnProjectCard?, content, preset? }` |
| `PATCH` | `/api/prompts/:id` | Update a prompt. Body: `{ projectDir?, scope?, title?, icon?, showOnProjectCard?, content?, preset? }` |
| `DELETE` | `/api/prompts/:id[?projectDir=<abs>][&scope=app\|project]` | Delete a prompt. Returns `{ ok, removed, clearedChats }` |

## Implementation notes

- Backend: [src/prompts.js](../../../src/prompts.js) — CRUD module supporting SQLite app storage and project-level `.mouaif.json` files, plus `normalizePreset`, `getPromptPreset`, `effectivePresetConfig`, and the snapshot pair `snapshotPrompt` / `resolveChatPrompt`.
- Routes: `handlePrompts()`, mounted at `/api/prompts/*` from [src/server-handlers-prompts.js](../../../src/server-handlers-prompts.js) (dispatched in [src/http-server.js](../../../src/http-server.js)).
- Chat schema: [src/chats.js](../../../src/chats.js) — `promptId` field on the chat, allowed in `updateChat`. A chat also carries `promptSnapshot` (`{ title, content, role, preset? }`), derived server-side from `promptId` at attach time and stored in `chat_store.prompt_snapshot`. It is server-owned: stripped from `POST /api/chats` and `PATCH /api/chats/:id`, and absent from the `LIST_COLUMNS` list projection. A `NULL` snapshot resolves live by `promptId`, which is the pre-snapshot behaviour. See decisions §32.
- Frontend: [frontend/src/components/SettingsPrompts.jsx](../../../frontend/src/components/SettingsPrompts.jsx) — dropdown-driven editor for both App defaults and Project-scoped custom prompts.
- Prompt icons: [frontend/src/components/PromptIcon.jsx](../../../frontend/src/components/PromptIcon.jsx) — shared safe SVG icon catalog used by the editor and project cards. `src/prompts.js` normalizes icon keys and the `showOnProjectCard` quick-launch flag.
