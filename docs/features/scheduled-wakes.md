# Scheduled wake-ups — let a chat come back to its own work later

## Overview

`schedule_wake`, `schedule_list` and `schedule_cancel` let the assistant plan its own follow-up. A wake is a saved message plus a time. When it is due, mouaif starts a new turn in the same chat with that message, as if the assistant had been prompted, so a long task can pause for hours and carry on without anyone polling.

Wakes are stored in the app database. They survive a restart: one that came due while mouaif was down fires once, promptly, when it starts again.

## Usage

Ask for something that takes a while — "start the full test run and check on it every 20 minutes until it is done" — and the model schedules its own check-ins:

```json
{ "message": "Read the test log under .mouaif/logs/ and tell me which tests failed.", "in": "20m", "every": "20m", "maxRuns": 6 }
```

| Tool | Arguments | Result |
| --- | --- | --- |
| `schedule_wake` | `message` (required, up to 2000 characters). Exactly one of `in` (`"90s"`, `"15m"`, `"2h"`, `"1h30m"`, `"1d"`) or `at` (an ISO 8601 time). Optional `every` (same format, at least 1 minute), `maxRuns` (1–100, default 10 with `every`) and `jobId`. | `id`, the due time, `dueInSeconds`, `runsLeft`. |
| `schedule_list` | none | This chat's pending wakes, soonest first. |
| `schedule_cancel` | `id` | `cancelled: true`, or the status it already had. |

With `jobId` (from [`group_cli`](grouped-cli-tool.md) `async: true`), the chat also wakes the moment that [background job](job-tools.md) settles, and the woken message says how it ended. `in` or `at` then acts as a deadline, so a job that never finishes still wakes the chat.

### Permissions

The three tools follow the **mouaif** family gate in **Settings → Project** (Off / Ask / Allow). A woken turn uses the chat's normal tool permissions, so anything that needs approval waits for you as usual.

## Behavior

- **A wake is an ordinary turn.** It uses the chat's selected model, prompt and tool settings. The saved message arrives as a user message that starts with `⏰ Scheduled wake-up`.
- **Busy chats wait.** If the chat is already streaming, the wake is tried again a few seconds later; nothing is lost and no attempt is counted.
- **Failures retry.** A wake that cannot start (for example the provider is down) is retried with a growing delay and marked `failed` after three attempts. The last error is kept.
- **Repeating wakes do not catch up.** After each run the next one is due `every` later, counted from the moment it ran. Time spent down is not replayed.
- **Limits.** At most 20 pending wakes per chat, a first wake between 10 seconds and 30 days away, a repeat interval of at least a minute, and at most 100 runs. These stop an agent from waking itself in a tight loop.
- **Chats own their wakes.** A chat sees and cancels only its own schedules. Deleting a chat cancels its wakes. A chat with no selected model cannot schedule one.
- **Finished wakes are kept for a week**, then removed.
- **At least once.** A wake is leased for five minutes while it is being delivered, so a crash mid-delivery repeats it instead of losing it.

## Related

- [Job tools](job-tools.md) — wait for, inspect and cancel background commands.
- [Chat model tools](chat-model-tools.md) — `start_chat`, the same background-turn path a wake uses.
