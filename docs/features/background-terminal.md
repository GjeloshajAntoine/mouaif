# Background terminal

## Overview

The CLI modal's shell keeps running after you close the sheet. An `npm install`, a test run, or a dev server survives going back to the chat, and reopening **Cli** reattaches to the same shell and shows what it printed while you were away.

## Usage

1. Open the composer's File button → **Cli** and start a command.
2. Close the sheet (close button or **Escape**). The shell keeps running.
3. While it runs, the **Cli** row in the File menu shows a green dot.
4. Reopen **Cli**. The screen replays the buffered output, then continues live.
5. Tap **Stop** in the sheet header (and confirm) to kill the shell. This is the only action in the UI that ends it.

## Behavior

- One shell per project. Reopening always returns the same session until it exits or is stopped.
- Output is kept in a ring buffer of about 256 KB per session. When older output was dropped, the replay starts with `… earlier output dropped …`.
- A shell that exits on its own (`exit`, a crash) is removed; its exit line is part of the replay until then.
- Sessions live in server memory. Restarting mouaif, including the in-chat restart tool, stops them.
- A phone that suspends the tab loses nothing: the shell keeps running and the next open replays.
- CLI output is not written to chat traces.

## API

All routes sit behind the same access gate as every other `/api` route.

```text
GET  /api/tools/cli/session?projectDir=<abs>   start or reuse; returns { id, seq, ... }
POST /api/tools/cli/command  { projectDir, cmd, raw? }
POST /api/tools/cli/close    { projectDir }     explicit Stop
GET  /api/tools/cli/sessions[?projectDir=<abs>]
     -> { sessions: [{ id, projectDir, shell, interactive, startedAt, running, seq, bytes }] }
GET  /api/tools/cli/output?id=<sessionId>&since=<seq>
     -> { id, running, seq, firstSeq, dropped, bytes, chunks: [{ seq, stream, data }] }
```

Live `cli_output` frames on `GET /events` carry the same `seq`, so a client replays with `output`, then ignores live frames at or below the last replayed `seq`.

## Related

- [CLI modal](cli-modal.md) — the terminal this extends.
- [Restart from chat](chat-app-restart.md) — a restart drops running sessions.
