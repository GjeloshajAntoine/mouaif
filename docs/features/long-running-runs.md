# Long-running runs — a budget, a pause button and a watchdog

## Overview

A **run** gives a chat that works for hours a goal, limits and a safety net. A [recurring task](scheduled-wakes.md) opens one automatically. A bar above the composer shows the goal and what is left, and lets you **Pause**, **Resume** or **Stop** it. mouaif enforces the limits, and notices when the assistant goes quiet without a next step.

Without a run, one-off wake-ups still work but have no budget, no controls and no watchdog.

## Recurring tasks

When the assistant sets a recurring task with `schedule_wake` (`every` or `time`), mouaif opens a run for the chat with limits sized to the schedule: the task's `maxRuns` and `until` if it has them, otherwise a year and a large turn allowance, plus its `maxCostUsd` if it has one. The bar shows the schedule instead of a turn budget: `Weekdays at 09:00 (Europe/Brussels) · next in 5h 30m · 4 runs · $0.40`.

- **Pause** holds the task: runs that come due are delivered after **Resume**. **Stop** cancels the task.
- A recurring task is never nudged: its schedule is its next step. The run ends, and you are notified, when the schedule does (count or end date reached, or the assistant cancels it).
- Setting a new recurring task re-targets the same run and resets its counters.
- A wake counts as a turn, so `maxRuns` doubles as the turn limit.

## Agent tool availability

`run_start`, `run_status` and `run_end` are not exposed to agents. Runs are opened by [recurring tasks](scheduled-wakes.md); the run bar's Pause, Resume, Stop and Dismiss are unchanged. The tool examples below describe the internal adapter in `src/tools/run.js`, not the agent tool surface.

## Usage

The limits a plain run takes:

```json
{ "goal": "Migrate all docs to the new layout", "maxTurns": 40, "maxCostUsd": 3, "maxHours": 12 }
```

| Tool | Arguments | Result |
| --- | --- | --- |
| `run_start` | `goal` (required). `maxTurns` (1–500, default 50), `maxCostUsd`, `maxHours` (up to 168, default 24). | The run: status, turns left, time left. |
| `run_status` | none | The same view. `shouldContinue` is false when the run is paused, stopped or out of budget. |
| `run_end` | `outcome`: `done` (default), `failed` or `blocked`. `summary`. | Ends the run, cancels its pending wake-ups and notifies you. |

### The run bar

While a run is active the bar sits above the composer: a status dot, the goal, then `7/40 turns · $0.62 of $3 · 10h left`.

- **Pause** holds the run. Wake-ups that come due are kept and delivered after **Resume**. A turn that is already streaming finishes.
- **Stop** ends the run, cancels its wake-ups and aborts a turn that is streaming. It takes two taps ("Tap to stop") so a stray touch cannot end a long job.
- A run that stalled or ran out of budget stays on the bar until you **Dismiss** it.

### Permissions

`run_start`, `run_status` and `run_end` follow the **mouaif** family gate in **Settings → Project**. Pause, Resume and Stop are yours alone; the assistant has no tool for them.

## Behavior

- **Limits apply at turn boundaries.** Each wake-up or reminder that starts a turn costs one turn. Before a wake is delivered mouaif checks the turn count, the time limit and the spend since the run started. When one is used up, the wake is replaced by a single final turn — "stop, summarize what was done and what remains" — the run becomes **exhausted**, every other pending wake is cancelled, and you get a notification. Your own messages do not use up turns.
- **Cost counts priced turns only.** A model with no known price adds nothing, so set a turn limit too.
- **After the end, no more scheduling.** `schedule_wake` refuses once a run is stopped, ended, exhausted or stalled, so the assistant cannot quietly carry on.
- **The watchdog.** If a run has no turn streaming and no wake-up pending for 10 minutes, mouaif sends a check-in turn: continue, schedule the next check, or call `run_end`. Any `run_status` call counts as progress. After three check-ins with no progress the run is marked **stalled**, its wake-ups are cancelled and you are notified. A reminder costs a turn.
- **One run per chat.** Starting another while one is running or paused is refused. A finished run is kept for a week.
- **Survives a restart.** Runs are stored in the app database, so a pause, a budget and turn counts persist.

## What is not included

- **No hung-turn detection.** The watchdog watches runs that have gone idle, not a single turn that is stuck mid-stream. Stop aborts one by hand.
- **No autonomy level and no skip-step.** Tool permissions stay in the chat's Tools card and the project settings; use the plan from the `task` tool for steps.
- **Budgets do not interrupt a turn.** A turn that has started runs to its end.

## Related

- [Scheduled wake-ups](scheduled-wakes.md) — how the assistant comes back to the work.
- [Long-running agent mockup](long-running-agent-mockup.md) — the design this grew from.
