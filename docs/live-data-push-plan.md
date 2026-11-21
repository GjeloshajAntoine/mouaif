# Plan: push data to the client instead of polling

Status: proposal, for review. No code has changed yet.

## Problem

Live chat updates already arrive over streams. Alongside them, `useChatState.js` runs a reconcile tick every 1 s while following a run, 3 s when idle and 6 s when hidden, for as long as a chat is open. Each tick calls `/revision`, then fetches any new rows, then `/api/tools/authorization/pending`. That tick is the only way the page learns about writes made while no stream is open:

| Case | How it reaches the page | Waits for the tick? |
|---|---|---|
| The owner tab's reply: text, tool calls, results, subagent events, approval cards | the turn SSE | No |
| A follower tab's reply text, shell output, subagent events, approval cards | `/api/chats/:id/live` | No |
| A follower tab's tool call / result rows | the message store, via the tick | Yes, up to 1 s |
| A run started in another tab or device | the tick | Yes, up to 3 s (6 s hidden) |
| A background subagent's events and result after its turn ended | the message store only; no stream is open | Yes |

The last row is where the Agents panel bug came from. The background run's result is written by `appendMessage`, and no client is told. The tick later appended the row, but that path (`transcript.js` `syncTranscriptAppend`) never refreshed the panel, so the panel stayed stale until the chat was reopened.

The goal is not to speed up streaming, which already works. It is to tell the page about writes made outside a stream, so that no timer is needed except while a stream is down.

## Why the timers exist (git history)

| Timer | Added | Reason given |
|---|---|---|
| Chat reconcile tick (`useChatState.js`) | before 2026-08-08 (came with the frontend move `9b55723b`, no earlier history) | Follow a run started in another tab; notice a run starting elsewhere. |
| …stream recovery folded into it | `7632e079` 2026-08-10 | A dropped turn SSE is recovered by reading the saved rows until the run ends. Two timers merged into one. |
| …approval restore | `53e0c2e7` 2026-08-23, `7b512ba2` 2026-09-29 | A run parked on an approval writes no rows, so the tick also reloads the pending queue after back navigation / app return. |
| …PWA resume | `4288d3ca` 2026-08-23 | Refresh the open chat when the installed app comes back. |
| `@` mention items, 5 s (`Chat.jsx`) | before 2026-08-08 | New files / tools show up in the `@` list. |
| Project hooks bar (`ProjectHooksBar.jsx`) | `19729dbd` 2026-10-31 | Notice an untrusted hook / extension change. |
| Extension docks, app context bar | `d5106abe`, `489d692d` 2026-10-31 | Refresh extension views and their model context. |
| Share state, 4 s / 15 s (`ShareSheet`, `SharedWithMe`, `Projects`) | `32a8d84e` 2026-11-13 | See a peer accept / revoke a share. |
| MCP OAuth status, 3 s (`McpOAuth.jsx`); MCP App status, 5 s (`McpAppFrame.jsx`) | `dc937583`, `9f2eef2b` | Learn when a sign-in in another window finished; app server state. |
| Notification cold-launch (`notification-click.js`) | `6e1e52ba` 2026-09-15 | The service worker's store write can land after startup. Short, bounded. |
| PWA update check (`sw-registration.js`) | `2dd1d019` 2026-09-04 | Detect a new build without a reload. |

None of these is required by a spec. Each was the shortest way to cover a case the existing streams didn't. The only real need behind them is **recovery when a stream is lost**, which is kept below in a form that uses no timer.

Not data polling, and out of scope: dictation level meters and elapsed clocks, the mic button tick, screen capture interval, theme example clock, SSE heartbeats.

## What already exists

- `GET /events`: one app-wide SSE stream (`src/server-shared.js` `handleSSE` / `broadcast`). Today it only carries `data-update`, `content_changed` and `cli_output`, and only `CliModal` listens.
- `GET /api/chats/:id/live`: per-run replay of transient events (`src/live-chat.js`) with a `liveSeq` cursor. It exists only while a run is in flight and ends with `run_end`.
- The owner's turn SSE (`POST` send) for the tab that started the turn.
- Rows have a `seq`, and the client already fetches "rows after seq N" (`syncToNextSeq`).

## Design

### 1. One app event stream per tab

Make `/events` the single channel for "something changed". It carries small **notices**, never payloads: the client fetches what changed with the endpoints it already uses. Each notice is scoped by `projectDir` (+ `chatId` where relevant):

| Event | Sent when | Client does |
|---|---|---|
| `chat_rows` `{ projectDir, chatId, nextSeq }` | `messages.appendMessage` / row update / delete commits | If this chat is open and `nextSeq` > local: `syncToNextSeq` (rows after the local seq). Chat list updates its preview. |
| `chat_run` `{ projectDir, chatId, running, runId }` | A turn starts / ends (`finishLiveChat`) | Open chat: subscribe to `/live` or settle "done". Chat list: running dot. |
| `auth_pending` `{ projectDir, chatId, callId, open }` | `authorize` parks a prompt / `recordDecision` / cancel | Mount or remove the card (fetch `/pending` once on `open`). |
| `project_changed` `{ projectDir, what }` with `what` ∈ `hooks`, `extensions`, `files`, `tools`, `mcp_auth`, `share` | The matching store write / file watcher | The view showing that thing refetches once. |
| `app_changed` `{ what }` | App-level settings, share peers | Same. |

Rules:
- Emit from the **one write function** for each store (`appendMessage`, `setAuthorization`, hook trust, share store…), not from handlers, so every writer (HTTP, background subagent, hooks, CLI) is covered. This is exactly the gap behind the panel bug: the background subagent's result is written by `appendMessage` with no client told.
- Filter per client like `cli_output` already does: a share caller only gets its own project.
- Notices may coalesce (one `chat_rows` per tick of the event loop per chat), because the client always fetches "after my cursor", never applies a delta from the notice.

### 2. Client: one event store, views subscribe

- `frontend/src/liveEvents.js`: opens one `EventSource('/events')` per tab and exposes `subscribe(filter, fn)`. Views subscribe in an effect and clean up on unmount (react skill rule).
- The chat replaces the tick with handlers for `chat_rows`, `chat_run` and `auth_pending`. `syncToNextSeq`, `loadPendingAuthorization`, `subscribeLive` and the settle logic stay; only what calls them changes.
- Every row sync goes through one function that also refreshes the Agents panel, so no append path can skip it again.
- The other polling views switch to `project_changed` / `app_changed`.

### 3. Fallback when a stream doesn't work: kept, but event-driven

Losing a stream is the only real reason the poll exists. It stays covered without a timer:

- **Resync on (re)connect.** `EventSource` reconnects by itself. On every `open`, the client runs one catch-up: `/revision` + rows after its seq + `/pending` for the open chat, and a refetch for open views. Anything missed while disconnected is picked up then. This replaces the 1 s recovery loop of `7632e079`.
- **Resync on return.** `visibilitychange` → visible, `pageshow` (back/forward cache), `online` and the PWA resume path from `4288d3ca` run the same catch-up once. This covers `53e0c2e7` / `7b512ba2` (approval after back navigation, app return).
- **Turn stream drops.** The owner's turn SSE ending without `done` switches to following via `/live` + `chat_run` notices, not to polling.
- **No SSE at all** (a proxy that buffers or blocks `text/event-stream`): if `/events` fails to open N times in a row, show "live updates unavailable — showing saved state". Fall back to a slow, visibility-gated poll (15 s, stopped when hidden) for the open chat only. This is the one timer kept, and it exists only while the stream is down.

Kept as is: the notification cold-launch retry (bounded, a few tries at startup, not data polling of the server). The PWA update check moves to the service worker's own `updatefound` plus a check on `visibilitychange`.

## Steps

Step 1 and the chat part of step 2 fix the stale Agents panel. Steps 3 and later remove the remaining timers.

1. Server: `chat_rows`, `chat_run` and `auth_pending` notices from `messages.appendMessage` / `live-chat.js` / `authorization.js`, with per-client project filtering. Test with an HTTP script that a background subagent's late result emits `chat_rows`.
2. Client: `liveEvents.js`; the chat swaps the reconcile tick for notice handlers + the catch-up-on-open/return; route all row syncs through the one function that also syncs the Agents panel. Remove the tick and its cadence code.
3. Fallback: connection-failure counter and degraded-mode banner + slow poll.
4. Move the other views (`@` items, hooks bar, extension docks, context bar, share, MCP OAuth / app status) to `project_changed` / `app_changed`, one commit each.
5. Docs: update `chat-load-performance.md`, `tool-authorization.md` (§ parked prompt), `live-tool-preview.md`, `ask-user-tool.md` where they describe the poll; add an entry to `decisions.md`.

Each step is tested in the Docker test app: open a chat in two tabs, run a background subagent that needs approval, approve, and check both tabs and the Agents panel update with no requests between events (Network panel). Then kill and restart the server and check the catch-up on reconnect.

## Open questions

- Coalescing window for `chat_rows` during a fast turn: none (one notice per write, the client de-dupes by cursor) or about 50 ms?
- Should `chat_rows` carry the new rows themselves for the open chat, to save a round trip? It's simpler to keep notices payload-free; revisit only if latency shows up.
