# Chat row identity — implementation notes

> Agent-facing reference for [`docs/features/chat-client-row-ids.md`](../../features/chat-client-row-ids.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### Why

The chat view appends rows to `state.messages` before the server saves them. These are optimistic or live rows with no `seq`. When the saved copies arrived, `mergeServerRows` had to guess which unsaved row each one replaced: first by position within the trailing seq-less run, then by `role + content`. That guessing was the source of a long line of duplicate and misordering fixes (see the comments in `frontend/src/components/chat/msgMerge.js`). A `clientId` makes the match exact.

### Wire shape

`clientId` is an optional string matching `/^[A-Za-z0-9_-]{1,64}$/` (`messages.CLIENT_ID_RE`). Anything else is dropped by `normalizeMessage`.

| Row | Created by | Id source | Echoed on |
| --- | --- | --- | --- |
| User turn | client | `POST /api/chats/:id/messages/stream` body `clientId` (server makes one if absent) | message reads |
| Assistant segment | server | `messages.newClientId('a')` | `assistant_turn_end` frame `clientId` (owner SSE and live followers) |
| Final assistant answer | server | `messages.newClientId('a')` | `done` frame `clientId` |
| Stream error | server | `messages.newClientId('e')` via `persistStreamError` | `error` frame `clientId` |
| Direct `@agent` answer | client | `POST /api/tools/subagent` body `clientId` | message reads |
| Manual append | caller | `POST /api/chats/:id/messages` body `clientId` | response + reads |
| Tool call / result | — | none; identity stays `toolCallId` + `phase` | — |

Every message read (`GET /api/chats/:id/messages`, all window and `fromSeq` variants) returns `clientId` on rows that have one.

### Storage

`message_store.client_id TEXT` (nullable), added by `ensureTables()` in `src/chatdb.js` with `ALTER TABLE` when missing. `messageToRow` and `rowToMessage` map it, and `replaceMessages` keeps it. `appendMessage` checks uniqueness per chat. A taken id (a retry whose first attempt was saved before the failure surfaced) is replaced with `newClientId('r')`, so no two rows share one. There is no index. The lookup runs only when an id is supplied, and on the primary-key prefix `(project_dir, chat_id)`.

### Client

- `newClientId(prefix)` in `msgMerge.js` uses `crypto.getRandomValues`, with a `Math.random` fallback.
- `send()` in `stream.js` creates `userClientId` (or reuses `options.clientId` on a retry). It puts the id on the optimistic user row and the request body, and threads it through every retry payload.
- The `assistant_turn_end` / `done` handlers copy `data.clientId` onto the segment or final row they append to `state.messages`, and into `finalizeLiveMessage`, which stamps the live node's `_rowKey`.
- `appendErrorCard` puts `opts.clientId` on its row and stamps the card's `_rowKey`.
- `live.js` passes `data.clientId` to `finalizeLiveSegment`, which prefers it over `seq`.

### Merge

`mergeServerRows(state, rows)`:

1. Drop a row whose `seq` the client already holds (derived from `state.messages` by `heldSeqs`).
2. **The row has a `clientId`:** replace the held row with the same id. If none matches, splice the row in by `seq` (`insertionPointFor`). Return. The guessing never runs for id-carrying rows, so an unknown id (another tab's turn) cannot take the slot of a pending row.
3. **Legacy row (no `clientId`):** the unchanged positional pass, then the content fallback, then insert by `seq`.

### Row keys

`transcriptRowKey(m)` returns `cid:<clientId>` when present, before `seq:<n>`. An unsaved row and its saved copy therefore share one key, and `reconcileTranscriptRows` reuses the node without removing and rebuilding it. `appendMessageToTranscript` stamps the key on non-live rows that carry an id.

### Tests

- `scripts/test-chat-client-row-ids.js` — store round trip (store, echo, reject unsafe, replace taken ids, legacy rows), plus a full `handleChatStream` run against a fake upstream. It checks that the user id is kept, assistant rows get unique ids, tool rows get none, and `assistant_turn_end` / `done` carry the saved ids.
- `scripts/test-msg-merge.js` cases 11–15 — replacing by id across tool rows, an unknown id not taking a pending row's slot, a mid-transcript error card, legacy rows unchanged, and `newClientId` uniqueness.
