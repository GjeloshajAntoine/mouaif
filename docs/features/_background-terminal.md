# Background terminal — design note

> **Status: proposal, not implemented.** This file is prefixed with `_` on
> purpose: [scripts/build-docs.js](../../scripts/build-docs.js) skips
> `docs/features/_*.md`, so an unbuilt feature never lands in the published
> user guide. When the work ships, rename it to
> `docs/features/background-terminal.md` and add the one-line index entry to
> [docs/README.md](../README.md), as the project rules require.

## Overview

Today the CLI modal's shell dies with the modal: closing the sheet POSTs
`/api/tools/cli/close`, which kills the child ([src/server-handlers-tools.js](../../src/server-handlers-tools.js),
[frontend/src/components/chat/CliModal.jsx](../../frontend/src/components/chat/CliModal.jsx)).
A `npm install`, a test run or a dev server therefore stops the moment the user
goes back to the chat. A **background terminal** decouples the session's
lifetime from the modal's: the child keeps running, output is buffered, and the
modal can be reopened later to reattach to the same session and read what it
missed.

## Why this is feasible

Most of the infrastructure is already in place, which is what makes this a
scoped change rather than a new subsystem:

- **Sessions are already keyed by project and reused.** `cliSessions` is a
  `Map<projectDir, session>` and `ensureCliSession()` is idempotent
  ([src/server-handlers-tools.js](../../src/server-handlers-tools.js)), so
  reopening the modal for the same project already returns the live session
  instead of starting a second one. The server, not the modal, owns the
  session.
- **Output already travels on a shared channel.** `attachCliStream()` broadcasts
  `cli_output` frames over `GET /events`, and the client filters them by
  session id. A detached session keeps producing frames — nothing breaks if no
  client is listening.
- **A reaping path already exists.** `hookCliExit()` kills every session on
  server shutdown, and each session reaps itself on child exit. Long-lived
  sessions were an expected state even before this feature.
- **The missed-frame pattern already exists for chats.** The chat stream
  re-syncs a tab that was backgrounded
  ([src/server-handlers-chats.js](../../src/server-handlers-chats.js)), and
  pagination uses a `since` cursor. The background terminal needs the same
  shape, applied to a byte stream.

## Design

### Session lifetime

The rule changes from "modal life = shell life" to three independent events:

| Event | Today | With background terminal |
| --- | --- | --- |
| Modal unmounts | `POST /api/tools/cli/close` → killed | client detaches; child keeps running |
| Child exits on its own | session reaped | unchanged, plus a final `exit` frame is buffered |
| Server shuts down | `hookCliExit()` kills all | unchanged |
| User presses **Stop** | n/a | explicit close (existing endpoint) |

`closeCliSession()` and `POST /api/tools/cli/close` stay as they are — they
become the *explicit* stop rather than an automatic side effect of unmounting.

### Output buffering and replay

A PTY is not rewindable, so a client that reattaches after being away needs a
backlog. Add a bounded ring buffer to each session:

```js
// one entry per broadcast chunk, so a reattaching client can ask for what it missed
session.output = { seq: 0, chunks: [], bytes: 0 };  // cap ≈ 256 KB
```

- Every chunk gets a monotonically increasing `seq`, and `cli_output` frames
  carry it: `{ id, stream, data, seq }`.
- On attach the client sends the last `seq` it saw (or nothing, meaning "give
  me the tail"), and the server replays the missing chunks before resuming live
  frames — the same "missed frames" idea the chat stream already uses.
- The cap is a **ring**: the oldest chunks are dropped once the buffer is full,
  so a chatty dev server cannot grow the server's memory without bound. A
  dropped prefix is reported to the client so the modal can print
  `… earlier output dropped …` above the replayed tail, instead of silently
  showing a truncated transcript.
- This is why reattach must go through a replay endpoint rather than reusing
  `CliScreen` alone: the screen decoder rebuilds a grid from the bytes it
  receives, but it cannot invent bytes it never saw.

### Endpoints

Keep the three existing routes stable and add two:

```text
GET  /api/tools/cli/session?projectDir=<abs>   (existing) start/reuse — unchanged
POST /api/tools/cli/command  { projectDir, cmd, raw? }   (existing) — unchanged
POST /api/tools/cli/close    { projectDir }    (existing) — explicit stop

GET  /api/tools/cli/sessions
     → { sessions: [{ id, projectDir, shell, interactive, startedAt,
                      detached, seq, bytes, running }] }

GET  /api/tools/cli/output?id=<sessionId>&since=<seq>
     → NDJSON: one buffered chunk per line, then the stream continues,
       or a one-shot JSON tail when `since` is omitted.
```

`sessions` is what a UI needs to show "there is a shell still running in this
project" without opening the modal. `output` is the reattach path.

### Client

Mobile-first, single column, consistent with the existing sheet
([docs/features/modal-sheets.md](modal-sheets.md)):

- **No kill on unmount.** `CliModal`'s cleanup closes the `EventSource` only.
  The session id lives on the server; nothing is persisted client-side.
- **A visible stop.** The header gains a **Stop** action (with a confirm),
  which is now the only way the UI kills a shell. This is the deliberate
  trade: closing is safe, stopping is explicit.
- **Reopen reattaches.** `GET session` returns the same id, the modal replays
  the backlog from `since = 0` (or its remembered `seq`) and resumes live.
- **A running indicator.** While a project has a detached live session, the
  composer's File → **Cli** entry shows a small running dot, so the user knows
  a build is still going without opening the sheet. Tap targets stay
  ≥ 44 × 44 px; the indicator is a state on the existing row, never a new
  hover-only affordance.
- **Optional second surface (decide later).** A compact "background sessions"
  list — one row per live session with project, command-agnostic status and a
  Stop button — could live on the Settings → Project page. It is not needed for
  the first version, where the per-project session is the only one that
  matters.

### Cross-cutting behavior

- **Trace.** If a chat has trace-to-file on, the shell tool's events are traced;
  CLI-modal output is not part of a chat transcript, and this feature does not
  change that. No trace file is written for a detached session.
- **Authorization.** `GET /api/tools/cli/*` already sits behind the same
  session/access gate as every other `/api` route
  ([src/http-server.js](../../src/http-server.js)). A background session must
  not become a way to run commands while access protection is armed, so no
  route is added outside that gate.
- **Mobile/PWA.** A phone that backgrounds the tab drops the SSE connection;
  with the new model that is harmless — the session keeps running and replays
  on return. This is a real improvement over today's behavior, where a
  suspended tab would otherwise be expected to hold a live terminal.

## Risks and open questions

- **Memory.** The ring buffer is the only new unbounded risk; a hard byte cap
  and a replayed "dropped" marker contain it. Cap value (256 KB suggested) is a
  tuning decision.
- **Idle sessions.** Should a session with no attached client for N minutes be
  reaped? Arguments both ways: a forgotten `npm run dev` holds a port; but
  reaping surprises a user who expected their build to survive. Suggestion:
  keep running while the child is alive and let it exit naturally, offered as a
  settings toggle only if it turns out to annoy.
- **Server restart.** Sessions are in memory, so a restart (or the in-chat
  restart tool) loses them. Documented limitation, not solved here.
- **Windows.** The piped fallback stays as is; background lifetime is
  independent of PTY availability, so the feature works on both paths.
- **Which shell "runs in background" is ambiguous on reattach.** If a long
  command is still running, replaying its backlog then showing live output is
  the correct read; the modal must not print a new prompt row until the child
  actually produces one. `CliScreen` already handles the in-place redraw case
  ([frontend/src/components/chat/CliModal.jsx](../../frontend/src/components/chat/CliModal.jsx)).

## Suggested rollout

1. **Server: buffer + `seq`.** Add the ring buffer and tag frames. No behavior
   change for the client yet; a test asserts replay order and the cap.
2. **Server: `sessions` and `output` routes.** Reattach over HTTP + SSE.
3. **Client: stop-on-unmount removal + explicit Stop + reattach on reopen.**
4. **Client: running indicator** on the File → Cli row.

Each step is its own `feat:` commit, and this note moves to
`docs/features/background-terminal.md` with the code in step 3, when the
behavior is user-visible.

## Related

- [CLI modal](cli-modal.md) — the terminal this note extends.
- [Modal sheets](modal-sheets.md) — sheet lifecycle and focus behavior.
- [Chat backward pagination](chat-backward-pagination.md) — the `since`-cursor
  pattern reused for replay.
- [Restart from chat](chat-app-restart.md) — a restart drops in-memory
  sessions.
- [docs/decisions.md](../decisions.md) §30 — why the PTY is `script(1)`.
