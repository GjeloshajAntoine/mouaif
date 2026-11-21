# Live events — implementation notes

> Agent-facing reference for [`docs/features/live-events.md`](../../features/live-events.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### Notices

The stream carries notices, never payloads. Every notice names its project:

| Event | Data | Sent when |
|---|---|---|
| `chat_rows` | `{ projectDir, chatId, nextSeq }` | Rows are appended, replaced or cleared (`src/chatdb.js`) |
| `chat_run` | `{ projectDir, chatId, running }` | A turn starts or ends (`runningChats` in `src/server-shared.js`) |
| `auth_pending` | `{ projectDir, chatId, callId, open }` | An approval prompt is parked or settled (`src/tools/authorization.js`) |

```text
event: chat_rows
data: {"projectDir":"/home/me/app","chatId":"3fa94c1e","nextSeq":42}
```

Notices are sent from each store's one write function, not from HTTP handlers, so every writer is covered: a turn, a background subagent, a hook turn, the CLI. `chat_rows` is coalesced to one notice per chat per turn of the event loop. Because the page always fetches "rows after my seq", a dropped or merged notice loses nothing. `chat_run` is sent after any rows still queued, so a page that settles on "ended" already has the turn's last rows.

`src/app-events.js` owns the stream (`handleSSE`, `broadcast`) and the notice helpers. It requires nothing else from the server, so the stores can call it without a require cycle.

### Shared projects

A project added from another mouaif opens its stream through the share, at `/s/<share>/events?projectDir=…`. The share gate allows that route at files access. Each frame is filtered in `src/http-server.js`: the caller only gets notices about the shared project, and only gets its terminal's `cli_output` frames with full access.

### Client

`frontend/src/liveEvents.js` opens one `EventSource` per stream URL and shares it between views. `subscribeLiveEvents({ projectDir, onEvent, onResync, onDown })` returns the cleanup for an effect:

- `onEvent(name, data)` gets each notice for the project;
- `onResync()` runs after every connect and reconnect, so anything missed while the stream was down is fetched once;
- `onDown(down)` reports when the stream has failed three times without opening, and when it comes back.

The stream is closed while the tab is hidden, because a hidden tab should not hold one of the browser's few connections per host. It reopens and resyncs when the tab is shown. When the browser gives up on a stream (an HTTP error), it is retried after 2, 5, 15 and then 30 seconds, or at once when the network comes back.

### The open chat

`useChatState.js` runs one catch-up, `reconcileRunningChat` (`/revision`, rows after the local seq, pending approvals, then following or settling the run), when:

- a `chat_rows`, `chat_run` or `auth_pending` notice names this chat (a `chat_rows` whose `nextSeq` the page already has costs nothing);
- the stream connects or reconnects;
- the page comes back (`visibilitychange`, `pageshow`, `focus`, `online`);
- stream recovery or the chat load asks for it (`state._kickSync`).

`auth_pending` also acts directly. When it opens, the pending queue is loaded so the card mounts even when no run is open in this tab. When it closes, the card is removed unless this page is submitting it (`aria-busy`).

Catch-ups that arrive while one is in flight collapse into one more. Only two timers remain, both bounded: a recovery request that failed is retried after 1 second (recovery gives up after 6 failures), and the 15-second poll runs while the stream is down and the page is visible.

Every row sync also refreshes the Agents panel (`syncTranscriptAppend` calls `syncAgentNetwork`), so rows that arrive by a pure append no longer leave the panel stale.

### Tests

- `scripts/test-app-events.js` checks that each store write sends its notice, that writes coalesce, that `chat_run` comes after the last rows, and that a share caller hears only its project.
- `scripts/test-chat-reentry.js` drives the chat effect: notices and resyncs run the catch-up, and nothing polls while the stream is up.
