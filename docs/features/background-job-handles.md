# Background job handles

## Overview

Background `group_cli` results now include a stable `jobId` alongside the PID and log path. This is the foundation for future waits, not a new wait or cancellation tool.

## Usage

Start an asynchronous command with the existing grouped CLI tool:

```json
{"commands":[{"cmd":"npm run build","async":true}]}
```

The entry result includes a handle such as `job-<uuid>`. Unlike a PID, the handle is never reused for another command. Continue reading output using the returned `logPath`; no model-facing job lookup tool ships in this change.

## Behavior and limits

- Handles belong to the **owning project, chat and nested invocation (when present)**, even when the command executes in a separate chat working folder. Unknown, expired, and differently scoped handles all produce `ENOTARGET` in the internal lookup API.
- Metadata records `running`, `completed`, or `failed`, an exit code, an optional terminating signal, the working folder and log path. Zero exit means completed; nonzero exit, spawn failure or external signal termination means failed. A signal alone is not evidence of a user cancellation.
- Terminal metadata survives removal of the live child and remains available for one hour after settlement. Active records never expire. There are at most 2,048 records process-wide; when full, new background commands fail before spawn rather than evicting unexpired handles.
- This registry is **process-local**. Worker/app restart loses handles; log files remain. It stores no output, command text, callback, credentials or child process references. Reads prune expired metadata; no cleanup timer keeps the process alive.
- Existing detached execution is unchanged: cancelling the calling turn stops new batch entries, not already launched background commands. There is no background cancel endpoint yet.
- Ordinary `group_cli` authorization is unchanged. No tool names, tool counts, UI or REST/SSE endpoints were added.

See [Grouped CLI tool](grouped-cli-tool.md) for the existing execution and approval behavior.
