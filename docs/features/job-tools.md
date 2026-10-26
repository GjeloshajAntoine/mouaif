# Job tools — wait for, inspect and cancel background commands

## Overview

Three native tools let the assistant run long work without polling: `wait_for` sleeps or blocks until a background command finishes, `job_status` lists background commands or reads one with the end of its log, and `job_cancel` stops one. They work on the commands [`group_cli`](grouped-cli-tool.md) starts with `async: true`, and they are leaves of the **mouaif** tool family next to it.

Before these tools the assistant could start a build in the background but had to poll its log with `shell` to learn when it ended, and could not stop it at all.

## Usage

Ask for something long in a normal sentence — "start the full test run, and tell me when it finishes" — and the model chains the tools:

```json
{ "commands": [{ "cmd": "npm test", "async": true }] }
```

`group_cli` returns a `jobId`. The model then blocks on it:

```json
{ "until": "job", "jobId": "job-6f1c…", "seconds": 120 }
```

| Tool | Arguments | Result |
| --- | --- | --- |
| `wait_for` | `until`: `"duration"` or `"job"`. `seconds`: 1–240, default 30. `jobId`: required for `"job"`. | `satisfied`, `timedOut`, `waitedMs`. For a job also `outcome` (`completed`, `failed`, `cancelled`), exit code and the log tail. |
| `job_status` | `jobId` optional. `tailBytes`: 0–16000, default 4000. | Without `jobId`, every job of this chat (state, exit code, log path, times). With it, that job plus the end of its log. |
| `job_cancel` | `jobId` required. | `cancelled`, `alreadyFinished`, `stillRunning` and the final job state with its log tail. |

A `wait_for` that runs out of time is not an error: it reports `timedOut: true` and the job as still running, and the model calls it again or reads `job_status`. One wait is capped at four minutes.

### Permissions

The three tools follow the **mouaif** family gate in **Settings → Project** (Off / Ask / Allow), and each can carry its own override like `group_cli` does. Turning the family off hides them with the rest of the family.

## Behavior

- **Jobs are private to the caller.** A job belongs to the project, chat and nested invocation that started it. Another chat, or a subagent of the same chat, gets `ENOTARGET` for it, exactly as for an unknown or expired id.
- **Cancel stops the whole process group.** `SIGTERM` first, `SIGKILL` after three seconds for a command that ignores it. The tool waits up to five seconds so its result shows the settled state. A job cancelled this way settles as `cancelled`, not `failed`; a command that fails on its own stays `failed`. Cancelling twice, or cancelling a finished job, is safe.
- **Cancelling is not a rollback.** Files the command already wrote stay written.
- **Waiting never stops the command.** Ending the turn, or a `wait_for` that times out, leaves the job running; a turn that is stopped ends the wait with `cancelled: true`.
- **Jobs survive a restart as records.** Finished jobs are remembered for a day, including after mouaif restarts. A job that was still running when mouaif restarted is reported as `lost` (mouaif stops its commands when it exits), and `wait_for` returns on it immediately instead of hanging. The log file under `.mouaif/logs/` stays on disk and can be read with `read_file`. See [Background job handles](background-job-handles.md).
- **Waits only watch shell jobs and time.** Waiting on a chat, a subagent or a group is still refused; see [Bounded wait foundation](bounded-wait-foundation.md).

## Related

- [Grouped CLI tool](grouped-cli-tool.md) — starts the background commands these tools observe.
- [Background job handles](background-job-handles.md) — job identity, scope and retention.
- [Bounded wait foundation](bounded-wait-foundation.md) — the wait engine behind `wait_for`.
