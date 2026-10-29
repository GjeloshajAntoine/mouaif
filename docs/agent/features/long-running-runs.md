# Long-running runs implementation

## Overview

Implementation notes for `run_start`, `run_status`, `run_end`, the run bar and the watchdog. User-facing behavior is in `docs/features/long-running-runs.md`.

## Usage

Run `node scripts/test-runs.js`, `node scripts/test-long-run-e2e.js` and `node scripts/test-run-dock.mjs` (all wired into `npm run test:waits`).

## Implementation notes

- Recurring tasks: `agent_run.kind` is `'run'` or `'recurring'` (column added with `ALTER TABLE` on older databases). `startRecurring()` opens or re-targets (`store.retarget`) the chat's run with `RECURRING_MAX_TURNS`/`RECURRING_MAX_MS` unless the schedule gave `maxRuns`/`until`/`maxCostUsd`; `closeRecurring()` ends it quietly; `view()` adds `kind` and `schedule` (`describeSchedule`: text, `nextAt`, `runCount`). In `watch()` a recurring run with no pending schedule and no streaming turn is ended (`schedule finished`, notification) instead of nudged. `RunDock` shows `runLine()`'s recurring form.

- `src/runs.js`: `agent_run` table (one row per project/chat, created lazily), `createRunStore`, `createRunManager`, `sharedManager`. The manager owns the user controls (`pause`/`resume`/`stop`), the scheduler `gate`/`delivered` hooks and `watch()`.
- Enforcement lives in the scheduler (`src/schedules.js`, `hooks`): `gate()` returns `send`, `hold` (paused: `store.release` +30 s), `cancel` (run over) or `final` (budget used: the wake text is replaced by the wrap-up and `delivered()` cancels everything else queued). `delivered()` counts the turn. A throwing gate falls back to `send`, so a broken run store never eats wakes.
- `watch()` runs from the scheduler tick. It tracks idle time per run in memory (`idleSince`), so a restart gives a fresh window and a turn that just ended is not nudged at once. Nudges go through `startChatTurn`; `touch()` (from `run_status`) and a delivered wake reset `nudges`.
- Stop cancels pending wakes and calls the chat's `runningChatCancels` controller, the same one `POST /api/tools/authorization/cancel` uses.
- REST: `GET /api/chats/:id/run?projectDir=` and `POST /api/chats/:id/run { projectDir, action }` in `src/server-handlers-chats.js`. `ENOTARGET` maps to 409, a missing store to 503.
- Notifications use `push.sendPushToAll` with tag `chat-<id>-run`; failures are swallowed.
- Frontend: `RunDock.jsx` (polls the endpoint every 5 s while active, 30 s otherwise, and not while the tab is hidden) with its text helpers in `runDock.js` and styles in `run-dock.css`, mounted in `Chat.jsx` next to `AgentNetworkDock`. Dismissal of a stalled or exhausted run is per browser (`localStorage`, keyed by chat and run start).
- Tools: `src/tools/run.js`; dispatch in `src/ai-stream.js`; catalog in `src/server-handlers-tools.js`; family leaves in `src/tools/authorization.js` and `frontend/src/toolGroups.js`. `schedule_wake` asks `runOf()` and refuses with `ERUN_ENDED`.
- Tests: `scripts/test-runs.js` (real SQLite, fake clock), `scripts/test-long-run-e2e.js` (real dispatcher, scheduler, chat runner and REST handler; only the model is faked), `scripts/test-run-dock.mjs`.
