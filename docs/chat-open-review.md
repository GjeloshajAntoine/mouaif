# Chat open review: how the chat view loads and where it can be faster

Reviewed on 2026-11-15. Items 1–3 were fixed the same day (see [Chat load performance](./agent/features/chat-load-performance.md#open-order-usechatstatejs--load-frontendsrcchatprefetchjs)).

## Summary

The chat view can be shown noticeably faster. On a cold open, the first message appears about 500 ms after the messages have already arrived from the server. That gap is waiting and rendering work that can be reordered.

## How it was measured

- A cold open of a 2,000-row fixture chat (the `long` profile from `scripts/lib/perf-fixtures.mjs`) in the Docker test app on `:5732`, driven through the stack's own Chrome at 430 × 932.
- That Chrome is capped at half a core, so absolute times are inflated. The proportions are what matter.
- The test app ran the baked `mouaif-app:latest` image, not the working tree. The load code read for this review matches the waterfall recorded.
- Server times come from `curl` against the same app (also capped at half a core).

## Timeline of a cold open

Milliseconds from navigation, with the bundle already cached:

| Time | What happens |
| --- | --- |
| 190 | Bundle downloaded (820 KB, 217 KB compressed) |
| 500 | `/api/share/state` is requested |
| 890 | `/api/access/status` is requested (the sign-in gate) |
| 1100 | Chat requests start |
| 1283 | First page of messages (100 rows, 96 KB) has arrived |
| 1328 | Last of the 10 parallel requests returns |
| 1390–1479 | Authorization request, sent only after the other 10 |
| 1481–1780 | One 300 ms task builds all the rows |
| 1783 | First row visible |

After that, the background drain adds 100 older rows about every 350 ms until the whole transcript is in the DOM.

## Server time per request

| Request | Time | Size |
| --- | --- | --- |
| `GET /api/chats/:id` | 2–4 ms | 0.4 KB |
| `GET /api/chats/:id/messages?limit=100` | 3–4 ms | 96 KB |
| `GET /api/chats/:id/system-prompt` | 26–69 ms | 9 KB |
| `GET /api/tools/authorization` | 22–45 ms | 7.6 KB |
| `GET /api/tools/list` | 2–5 ms | 55 KB |
| The other open-time requests (models, providers, prompts, MCP servers, agents, actions, settings) | 1–5 ms | under 2 KB each |

The server is not the bottleneck. The time goes to the order of work in the client.

## What slows it down

### 1. The transcript waits for data it does not need (fixed)

`load()` in `frontend/src/components/chat/useChatState.js:999` awaits all 10 requests in one `Promise.all`, then awaits `/api/tools/authorization` (line 1113), and only then calls `renderTranscriptBound()` (line 1161). Only the chat record and the messages are needed to draw rows.

Rendering as soon as those two arrive saves about 200 ms in this measurement, and more on a mobile link, where the extra round trip costs more. The header cards (tools, system prompt) can fill in when their data arrives, the way the tool catalog already does.

### 2. The whole first page is built in one task (fixed)

The latest-first chunked render only starts at 120 rows (`TRANSCRIPT_CHUNK_THRESHOLD` in `frontend/src/components/chat/transcript.js:2685`), but the first page is 100 rows, so it never applies on open. All rows are built in a single 300 ms task.

Painting the last 20–30 rows first and backfilling the rest would cut most of that task.

### 3. Chat requests start late (fixed)

The bundle is ready at 190 ms, but nothing chat-related is requested until 1100 ms. `AccessGate` (`frontend/src/components/AccessAuth.jsx:206`) mounts the app only after `/api/access/status` returns, and the chat effect runs only after that mount.

The chat and messages fetches could start from the URL hash at boot, in parallel with the gate. The server enforces access anyway.

### 4. About 27 requests fire at once over 6 connections

The server speaks HTTP/1.1, so the browser opens at most 6 connections. The messages request waited 80–107 ms for a free one.

Several requests are duplicates:

- `/api/settings` three times (one is `loadApp({ force: true })` in the chat load)
- `/api/projects/registered` twice
- `/api/git` twice
- the project tags twice
- the chat artifacts twice

The git status, CLI sessions and the 100-chat switcher list could wait until after first paint.

### 5. API JSON is sent uncompressed

`sendJSON` in `src/server-shared.js:116` writes raw JSON, while static assets get brotli or gzip. A 100-row page of a real tool-heavy chat can be several hundred KB.

Not checked: whether the reverse proxy in front of prod already compresses these responses.

### 6. The background history drain competes with the user right after open

The drain adds 100 rows every 350 ms or so, with 120–220 ms long tasks, until the whole transcript is in the DOM. For 2,000 rows that keeps the main thread busy for several seconds, just when the user starts reading or typing.

This is the documented design ([Chat backward pagination](./features/chat-backward-pagination.md)), so changing it is a bigger decision. One option: fetch the pages into memory but build rows only when the user scrolls near them.

### 7. Two server handlers are slow relative to the rest

`system-prompt` takes 26–69 ms and `authorization` 22–45 ms, against 1–4 ms for the others. Both run synchronously, so other requests queue behind them on the single server thread.

## Recommendation

1. Start with items 1 and 2. Both are small client-only changes, and together they remove most of the gap between "messages arrived" and "first row visible".
2. Then items 4 and 5: fewer and smaller requests.
3. Item 3 saves the most on a slow device but touches the boot path.
4. Item 6 needs a design decision before any work.

## Side finding

The `:9222` debug Chrome is signed out of prod. API fetches from that tab hung for over 4 s instead of failing, while `curl` gets an immediate 401 from the same server. This was not diagnosed.

## Related

- [Chat load performance](./features/chat-load-performance.md)
- [Chat backward pagination](./features/chat-backward-pagination.md)
- [Chat streaming performance](./features/chat-streaming-performance.md)
