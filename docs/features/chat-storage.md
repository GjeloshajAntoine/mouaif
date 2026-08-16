# Chat storage — SQLite-backed chat and message persistence

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
