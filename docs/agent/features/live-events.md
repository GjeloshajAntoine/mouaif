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
| `project_changed` | `{ projectDir, what, chatId? }` | `what` is `hooks` (`src/projectHooks.js` trust, `append`), `extensions` (project extension trust or switch, `src/extensions.js`), `app_context` (`src/app-context.js`), `run` (`src/runs.js` store), `webhook` (`src/webhooks.js` store), `chat_hooks` (`src/chatHooks.js`, `hooks.logRun`) |
| `app_changed` | `{ what }` | `share` (`src/share-store.js` writes except a peer's last-seen time, a peer connecting or disconnecting in `src/share.js`), `extensions` (app extension import, switch, removal), `mcp_auth` (`src/oauth-mcp.js` token store, a finished sign-in) |

```text
event: chat_rows
data: {"projectDir":"/home/me/app","chatId":"3fa94c1e","nextSeq":42}
```

`project_changed` and `app_changed` are coalesced the same way, per (project, what, chat) and per `what`. Notices are sent from each store's one write function, not from HTTP handlers, so every writer is covered: a turn, a background subagent, a hook turn, the CLI. `chat_rows` is coalesced to one notice per chat per turn of the event loop. Because the page always fetches "rows after my seq", a dropped or merged notice loses nothing. `chat_run` is sent after any rows still queued, so a page that settles on "ended" already has the turn's last rows.

`src/app-events.js` owns the stream (`handleSSE`, `broadcast`) and the notice helpers. It requires nothing else from the server, so the stores can call it without a require cycle.

### Shared projects

A project added from another mouaif opens its stream through the share, at `/s/<share>/events?projectDir=…`. The share gate allows that route at files access. Each frame is filtered in `src/http-server.js`: the caller only gets notices about the shared project, and only gets its terminal's `cli_output` frames with full access. `app_changed` never reaches a share caller.

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

### Other views

`subscribeChanges({ projectDir, chatId, project, app, runEnd, onChange })` in `liveEvents.js` is the shortcut for views that only refetch. `onChange` runs for a `project_changed` whose `what` is in `project` (and, when the notice names a chat, only for `chatId`), an `app_changed` whose `what` is in `app`, with `runEnd` any turn in the project ending, and every (re)connect.

| View | Was | Now |
|---|---|---|
| `ProjectHooksBar.jsx` | 30 s | `hooks`, `extensions`; app `extensions`; turn end |
| `ExtensionDocks.jsx` (one feed per project) | 30 s | `extensions`; app `extensions`; turn end |
| `AppContextBar.jsx` | 20 s while a view was active | `app_context` for the chat |
| `HooksDock.jsx` | 4 / 10 / 15 s | `chat_hooks` for the chat |
| `WebhookDock.jsx` | 4 / 10 / 15 s | `webhook` for the chat; turn end |
| `RunDock.jsx` | 5 / 30 s | `run` for the chat; turn end |
| `Chat.jsx` `@` items | 5 s | turn end; `extensions`, `hooks`; the popup rescans on open |
| `ShareSheet.jsx`, `SharedWithMe.jsx` | 4 s | app `share` |
| `Projects.jsx` shared cards | 15 s | app `share` |
| `McpOAuth.jsx` | 3 s | app `mcp_auth`; window focus |
| `McpAppFrame.jsx` status | 5 s | the chat's `chat_rows`, any turn end, `extensions`; at most every 2 s |
| `sw-registration.js` update check | 60 s while visible | every stream reconnect (a new build ships with a server restart); `visibilitychange` |

Files changed outside a chat (an editor, `git pull`) are not watched: a hook, extension or app file edited that way shows on the next turn end or page return. Untrusted hooks and extensions are off until reviewed, so a late bar runs nothing.

Timers that remain and are not data polling: the notification cold-launch retry (`notification-click.js`, bounded), dictation level meters and clocks, the mic button tick, screen capture, the theme example clock, SSE heartbeats, and the 2 s throttle of the MCP App status check.

### Tests

- `scripts/test-app-events.js` checks that each store write sends its notice (rows, runs, approvals, hook and extension trust, app context, share state, run, webhook and chat hook stores), that writes coalesce, that `chat_run` comes after the last rows, and that a share caller hears only its project and no app-wide notices.
- `scripts/test-chat-reentry.js` drives the chat effect: notices and resyncs run the catch-up, and nothing polls while the stream is up.
