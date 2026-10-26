# Background job handles

## Overview

Background `group_cli` results now include a stable `jobId` alongside the PID and log path. The [job tools](job-tools.md) (`wait_for`, `job_status`, `job_cancel`) use these handles.

## Usage

Start an asynchronous command with the existing grouped CLI tool:

```json
{"commands":[{"cmd":"npm run build","async":true}]}
```

The entry result includes a handle such as `job-<uuid>`. Unlike a PID, the handle is never reused for another command. Read output through the returned `logPath`, or use `job_status` for the state and the end of the log.

## Behavior and limits

- Handles belong to the **owning project, chat and nested invocation (when present)**, even when the command executes in a separate chat working folder. Unknown, expired, and differently scoped handles all produce `ENOTARGET` in the internal lookup API.
- Metadata records `running`, `completed`, or `failed`, an exit code, an optional terminating signal, the working folder and log path. Zero exit means completed; nonzero exit, spawn failure or external signal termination means failed. A signal alone is not evidence of a user cancellation.
- Terminal metadata survives removal of the live child and remains available for a day after settlement (an hour in memory, then from the app database). Active records never expire. There are at most 2,048 records process-wide; when full, new background commands fail before spawn rather than evicting unexpired handles.
- Live handles are process-local, but each job's metadata is also written to the app database (`background_job` table). After a restart, finished jobs keep their outcome and a job that was still running is reported as `lost`, because mouaif stops its background commands when it exits. Log files remain. Nothing stores output, command text, callbacks, credentials or child process references (only the pid). Recovered jobs obey the same project/chat/invocation scope as live ones. If the database cannot be opened, jobs fall back to memory only.
- Existing detached execution is unchanged: cancelling the calling turn stops new batch entries, not already launched background commands. `job_cancel` is the way to stop one; there is no REST endpoint for it.
- Ordinary `group_cli` authorization is unchanged. No REST/SSE endpoints were added.

See [Grouped CLI tool](grouped-cli-tool.md) for the existing execution and approval behavior.
