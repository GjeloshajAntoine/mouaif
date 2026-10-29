# Scheduled wake-ups and recurring tasks — let a chat come back to its own work

## Overview

`schedule_wake`, `schedule_list` and `schedule_cancel` let the assistant run a prompt in a chat later, once or on a repeat. Ask for something at a regular time — "every weekday at 9 summarise the overnight alerts" — and the assistant saves the prompt and the time. Each time it is due, mouaif starts a new turn **in the same chat** with that prompt, so every run continues the conversation: what earlier runs said and did, the files they wrote and the attachments you sent are all still there.

A wake is a saved prompt plus a time, stored in the app database. It survives a restart: one that came due while mouaif was down fires once, promptly, when it starts again.

## Usage

```json
{ "message": "Summarise the overnight alerts and save them to reports/today.md", "time": "09:00", "days": ["mon", "tue", "wed", "thu", "fri"], "timezone": "Europe/Brussels" }
```

```json
{ "message": "Read the test log under .mouaif/logs/ and tell me which tests failed.", "in": "20m", "every": "20m" }
```

| Tool | Arguments | Result |
| --- | --- | --- |
| `schedule_wake` | `message` (required, up to 4000 characters). First run: `in` (`"90s"`, `"15m"`, `"2h"`, `"1h30m"`, `"1d"`) or `at` (an ISO 8601 time). To repeat: `every` (an interval, at least 1 minute) **or** `time` (a 24-hour clock time) with optional `days` and `timezone`. Optional `maxRuns`, `until` and `maxCostUsd` for a repeat. | `id`, the due time, `dueInSeconds`, `repeat`, `runsLeft`, and for a repeat its [run](long-running-runs.md). |
| `schedule_list` | none | This chat's pending schedules, soonest first. |
| `schedule_cancel` | `id`, or nothing to cancel the recurring task | `cancelled: true`, or the status it already had. |

### Two ways to say "regularly"

- **An interval** — `every: "30m"`, `"6h"`, `"1d"`. The next run is counted from the *planned* time, not from when the last run finished, so it does not drift. Intervals ignore daylight saving.
- **A clock time** — `time: "09:00"`, optionally `days` (default every day) and `timezone` (an IANA name such as `Europe/Brussels`; default the machine's). It follows daylight saving, so "09:00" stays 09:00. Without `in` or `at` the first run is the next such time.

### How it ends

A repeat goes on until it is cancelled. `maxRuns` and `until` (an ISO time) end it sooner, and **Stop** on the [run bar](long-running-runs.md) cancels it at any time. When the last run is delivered, the task and its run bar finish and you get a notification.

### One recurring task per chat

A chat has one recurring task: setting a new one replaces the old one (the result says `replacedPrevious`). One-off wakes — "check the build in 20 minutes" — can sit beside it.

### Permissions

The three tools follow the **mouaif** family gate in **Settings → Project** (Off / Ask / Allow). A woken turn uses the chat's normal tool permissions, so anything that needs approval waits for you as usual.

## Behavior

- **A run is an ordinary turn in the same chat.** It uses the chat's selected model, prompt and tool settings, and sees the whole conversation so far, including image attachments. A recurring run starts with exactly the prompt you set, as a plain user message, and nothing else is added: the earlier runs are already in the chat above it. A one-off wake arrives labelled `⏰ Scheduled wake-up`, so the assistant knows it came from its own schedule.
- **Runs never overlap.** If a run comes due while the previous turn (or you) is still streaming in the chat, it waits and starts when the chat is free. Slots missed in the meantime, or while mouaif was down, are skipped, not replayed: you get one run, then the next slot after it.
- **Failures retry.** A wake that cannot start (for example the provider is down) is retried with a growing delay and marked `failed` after three attempts. The last error is kept.
- **Safety net.** A recurring task opens a [run](long-running-runs.md) with limits sized to it: your `maxRuns` and `until`, otherwise one year and a large turn allowance, plus `maxCostUsd` if given. You can Pause, Resume or Stop it from the bar above the composer.
- **Limits.** At most 20 pending schedules per chat, a first run between 10 seconds and 30 days away, an interval of at least a minute, and at most 10000 runs.
- **Chats own their schedules.** A chat sees and cancels only its own. Deleting a chat cancels them. A chat with no selected model cannot schedule one.
- **Finished wakes are kept for a week**, then removed.
- **At least once.** A wake is leased for five minutes while it is being delivered, so a crash mid-delivery repeats it instead of losing it.

## Past runs stay in the chat

Nothing a recurring task did is ever removed. Every run's prompt, the assistant's replies, the tool calls and the files stay in the chat, and you can scroll back to any of them (older pages load as you scroll up, or in the background).

- **Each run is marked.** The prompt a recurring task starts shows `Scheduled · run N` next to its time, so scrolling back through many runs shows where each one begins.
- **A list to jump.** While the chat has scheduled runs, the bar above the composer has a **Runs** button (once the task has ended, a slim bar with the number of runs keeps it available). It opens a list, newest first, with each run's number and time; a divider marks where an earlier, replaced task begins. Tap a run to load older pages if needed, scroll to it and highlight it.
- **The assistant sees them too.** Because every run is in the same chat, a run can rely on what earlier runs said and made, and on every attachment, without it being passed again. mouaif does not trim or summarise that history, so a task that runs often in one chat grows the conversation every time; a task that runs many times a day is better as a fresh chat now and then.

## Related

- [Long-running runs](long-running-runs.md) — the pause/stop bar and safety limits behind a recurring task.
- [Chat model tools](chat-model-tools.md) — `start_chat`, the same background-turn path a wake uses.
