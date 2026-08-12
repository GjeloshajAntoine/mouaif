# Chat storage — SQLite-backed chat and message persistence
<!--
Static-page-ready. No SSG shortcodes. Update docs/README.md in the
same commit that adds this file.
-->
## Overview
mouaif stores chat metadata and messages in the app-level SQLite database (`~/.mouaif/store.sqlite`), the same SQLite store used for app settings. There is no file-based chat storage backend: legacy `.mouaif.messages.*.json` transcripts were removed. To keep a chat's history as a project file you can commit, use the per-chat trace-to-file export (see [trace.md](./trace.md)).
## Usage
### Default behavior
All chats and messages are stored in the DB. No action needed.
### Committing a chat's history
Chat storage and the trace export are independent. To write a chat's transcript next to the project source:

1. Open the chat, then its settings.
2. Open **Technical details** (or **Settings → Project → Technical details** with the chat's `chatId`).
3. Toggle **Trace this chat** to append events to `<projectDir>/.mouaif/traces/<chatId>.ndjson`, or tap **Export trace** for a one-shot write.

The trace file is user-owned: it can be `git add`-ed with the project and is kept when the chat is deleted. See [trace.md](./trace.md).
### Legacy JSON import
For users upgrading from an earlier version, a one-shot import from the old `.mouaif.messages.*.json` files is available as a code path (`src/chatdb.js` → `importFromJson`) and the `mouaif import-chats` CLI command. The automatic startup migration that ran this import has been retired; JSON files are no longer read as a storage backend.
## Implementation notes
### DB schema (in `~/.mouaif/store.sqlite`)
**`chat_store`** table — one row per chat:
| Column | Type | Notes |
|--------|------|-------|
| `project_dir` | TEXT | Part of composite PK |
| `id` | TEXT | 8-char hex, part of PK |
| `title` | TEXT | |
| `created_at` | TEXT | ISO 8601 |
| `last_opened_at` | TEXT | Nullable |
| `trace` | INTEGER | 0 or 1 |
| `prompt_size` | TEXT | `very-small`, `average`, `extensive` |
| `prompt_id` | TEXT | Nullable |
| `provider_id` | TEXT | Nullable |
| `model_id` | TEXT | Nullable |
| `thinking_level` | TEXT | `''` default; the per-chat reasoning-effort override from the thinking dropdown (see [thinking-level.md](./thinking-level.md)) |
| `draft` | TEXT | Defaults to `''` |
| `tools` | TEXT | JSON array or NULL |
| `agent_id` | TEXT | Legacy — always NULL; kept for old DBs, no longer read or written |
| `agent_files` | INTEGER | 0, 1, or NULL (=undefined) |
| `skills` | INTEGER | 0, 1, or NULL (=undefined) |
**`message_store`** table — one row per message:
| Column | Type | Notes |
|--------|------|-------|
| `project_dir` | TEXT | Part of composite PK |
| `chat_id` | TEXT | Part of PK |
| `seq` | INTEGER | Part of PK, auto-incrementing per chat |
| `role` | TEXT | `user`, `assistant`, `system`, `tool` |
| `content` | TEXT | |
| `ts` | TEXT | ISO 8601 |
| `reasoning` | TEXT | Nullable, assistant only |
| `usage` | TEXT | Nullable, JSON |
| `cost` | TEXT | Nullable, JSON |
| `streaming_ms` | INTEGER | Nullable |
| `model_id` | TEXT | Nullable |
| `attachments` | TEXT | Nullable, JSON array |
| `tool_call_id` | TEXT | Nullable, tool only |
| `name` | TEXT | Nullable, tool only |
| `args` | TEXT | Nullable, JSON |
| `ok` | INTEGER | Nullable, 0/1 |
| `phase` | TEXT | `call` or `result` |
### Module structure
- **`src/chatdb.js`** — direct SQLite CRUD for chats and messages. Tables are created lazily with `IF NOT EXISTS`. Also keeps the legacy `importFromJson` one-shot importer.
- **`src/chats.js`** — public API for chats, delegates to `chatdb.js`.
- **`src/messages.js`** — public API for messages, delegates to `chatdb.js`.
### Message `seq` — the stable per-chat row identity
Every message exposed by `GET /api/chats/:id/messages` carries a `seq` field: its stable, monotonically increasing position within that `(project_dir, chat_id)`.
- **SQLite backend:** `seq` is the `message_store` primary-key column, assigned at insert (append-only, so a row keeps its `seq` forever).
`seq` is chat-scoped, so it is safe when many chats across many projects run concurrently. It is the single identity the frontend's reconcile/recovery path merges by — see [`chat-streaming-performance.md`](chat-streaming-performance.md) and `frontend/src/components/chat/msgMerge.js`.
