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
| `wait_for` | `until`: `"duration"`, `"job"`, `"chat"`, `"subagent"` or `"group"`. `seconds`: 1–240, default 30. `jobId` for one job, or `ids` (up to 20) for several. `mode`: `"all"` (default) or `"any"`. | `satisfied`, `timedOut`, `waitedMs`. A single job also returns `outcome` (`completed`, `failed`, `cancelled`, `lost`), exit code and log tail. Several targets return `settled`, `total` and each target's state. |
| `job_status` | `jobId` optional. `tailBytes`: 0–16000, default 4000. | Without `jobId`, every job of this chat (state, exit code, log path, times). With it, that job plus the end of its log. |
| `job_cancel` | `jobId` required. | `cancelled`, `alreadyFinished`, `stillRunning` and the final job state with its log tail. |

### What `wait_for` can wait on

| `until` | Waits for | Rules |
| --- | --- | --- |
| `duration` | `seconds` to pass. | — |
| `job` | Background commands started with `group_cli` (`async: true`). | Only this chat's own jobs. |
| `chat` | Other chats of the same project to stop running, for example ones started with `start_chat`. | A chat that is not running counts as finished. A chat cannot wait for itself. Chats of other projects are out of reach. Use `get_chat` afterwards to read what a chat produced. |
| `subagent` | Background subagents you launched (`callId`). | Only the parent that launched them, and only in the turn that launched them. Waiting on yourself or an ancestor is refused. |
| `group` | A subagent group (`groupId`) to settle: every member completed, failed, was cancelled or blocked. | Same turn rules as `subagent`. |

With several `ids`, `"all"` returns when every target has finished and `"any"` as soon as the first has, so "start five chats and wait for all of them" is one call.

A `wait_for` that runs out of time is not an error: it reports `timedOut: true` and the job as still running, and the model calls it again or reads `job_status`. One wait is capped at four minutes.

### Permissions

The three tools follow the **mouaif** family gate in **Settings → Project** (Off / Ask / Allow), and each can carry its own override like `group_cli` does. Turning the family off hides them with the rest of the family.

## Behavior

- **Jobs are private to the caller.** A job belongs to the project, chat and nested invocation that started it. Another chat, or a subagent of the same chat, gets `ENOTARGET` for it, exactly as for an unknown or expired id.
- **Cancel stops the whole process group.** `SIGTERM` first, `SIGKILL` after three seconds for a command that ignores it. The tool waits up to five seconds so its result shows the settled state. A job cancelled this way settles as `cancelled`, not `failed`; a command that fails on its own stays `failed`. Cancelling twice, or cancelling a finished job, is safe.
- **Cancelling is not a rollback.** Files the command already wrote stay written.
- **Waiting never stops the command.** Ending the turn, or a `wait_for` that times out, leaves the job running; a turn that is stopped ends the wait with `cancelled: true`.
- **Jobs survive a restart as records.** Finished jobs are remembered for a day, including after mouaif restarts. A job that was still running when mouaif restarted is reported as `lost` (mouaif stops its commands when it exits), and `wait_for` returns on it immediately instead of hanging. The log file under `.mouaif/logs/` stays on disk and can be read with `read_file`. See [Background job handles](background-job-handles.md).
- **A wait is bounded.** One call waits at most four minutes; a timeout reports how many targets are still running and the model calls again. Ending the turn cancels the wait and stops nothing it was watching.

## Related

- [Grouped CLI tool](grouped-cli-tool.md) — starts the background commands these tools observe.
- [Background job handles](background-job-handles.md) — job identity, scope and retention.
- [Bounded wait foundation](bounded-wait-foundation.md) — the wait engine behind `wait_for`.
