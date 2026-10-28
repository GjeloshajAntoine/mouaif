# Bounded waits — durations, chats and delegated work

## Overview

`wait_for` pauses for a bounded duration or waits for chats, subagents and groups. Background commands instead use [`shell`](shell-tool.md) with `async: true`, returning a PID and log path. Inspect logs and processes, or stop processes, with shell commands; there are no model-facing job-status or job-cancel tools.

## Usage

```json
{ "until": "duration", "seconds": 30 }
```

`seconds` is 1–240 (default 30). For chat, subagent and group targets, supply `ids` (up to 20) and optionally `mode: "all"` (default) or `"any"`.

### What `wait_for` can wait on

| `until` | Waits for | Rules |
| --- | --- | --- |
| `duration` | `seconds` to pass. | — |
| `chat` | Other chats of the same project to stop running, for example ones started with `start_chat`. | A chat that is not running counts as finished. A chat cannot wait for itself. Chats of other projects are out of reach. Use `get_chat` afterwards to read what a chat produced. |
| `subagent` | Background subagents you launched (`callId`). | Only the parent that launched them, and only in the turn that launched them. Waiting on yourself or an ancestor is refused. |
| `group` | A subagent group (`groupId`) to settle: every member completed, failed, was cancelled or blocked. | Same turn rules as `subagent`. |

With several `ids`, `"all"` returns when every target has finished and `"any"` as soon as the first has, so "start five chats and wait for all of them" is one call.

A wait that runs out of time is not an error: it reports `timedOut: true`. One call is capped at four minutes. Waiting never stops what it observes; ending the turn cancels the wait.

### Permissions

`wait_for` follows the **mouaif** family gate and its own leaf override. Shell execution is governed separately by `tools.shell`.

## Related

- [Shell tool](shell-tool.md) — command execution, background PIDs and logs.
- [Scheduled wakes](scheduled-wakes.md) — time-based follow-ups across turns.
- [Bounded wait foundation](bounded-wait-foundation.md) — the wait engine behind `wait_for`.
