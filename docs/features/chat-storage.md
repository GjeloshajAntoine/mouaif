# Chat storage — SQLite-backed chat and message persistence

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

By default, mouaif stores chat metadata and messages in the app-level SQLite database (`~/.mouaif/store.sqlite`), the same SQLite store used for app settings. Legacy file-based storage (`.mouaif.messages.*.json` files) is still available as a fallback via the `chatStorage` app setting.

## Usage

### Default behavior

All new chats are stored in the DB. No action needed.

### Switching back to JSON files

1. Go to **Settings → App defaults → Chat storage**
2. Select **"JSON files"**
3. Save

Existing chats in the DB are not migrated back to JSON. Only new chats follow the selected backend.

### Importing existing JSON chats into the DB

When a project already has `.mouaif.messages.*.json` files (from before the DB storage was enabled), they can be imported into the SQLite store:

**From the UI:**
1. Open **Settings → Project settings**
2. Tap **"Import chats"** under "Project add-ons"
3. Tap **"Import from JSON files"**

**From the CLI:**
```bash
mouaif import-chats /path/to/project
```

**On server start:**
The migration `2025-07-23-import-chats-to-db` runs automatically on `mouaif serve` startup and imports any un-imported JSON files for every registered project.

### API endpoint

```
POST /api/chats/import
Body: { projectDir: "<abs>", skipExisting?: true }
```

Returns `{ ok: true, imported: { chats: <n>, messages: <n>, errors: [...] } }`.

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
| `draft` | TEXT | |
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

- **`src/chatdb.js`** — direct SQLite CRUD for chats and messages. Tables are created lazily with `IF NOT EXISTS`.
- **`src/chats.js`** — public API, routes to `chatdb.js` or legacy JSON files based on `chatStorage` setting.
- **`src/messages.js`** — public API, routes to `chatdb.js` or legacy JSON files.

### Storage backend selection

The `useDb(projectDir)` helper reads `settings.getResolved(projectDir).chatStorage`. If `'db'`, all chat/message operations go through `chatdb.js`. If `'json'`, the legacy file-based code paths are used.

### Auto-import migration

The `2025-07-23-import-chats-to-db` migration in `settings.js` scans every registered project for `.mouaif.messages.*.json` files and imports them into the DB. It runs on every `mouaif serve` start (skipped if already run). Idempotent: `skipExisting: true` prevents re-importing chats already in the DB.