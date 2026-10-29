# Scheduled wakes and recurring tasks implementation

## Overview

Implementation notes for `schedule_wake`, `schedule_list` and `schedule_cancel`. User-facing behavior is in `docs/features/scheduled-wakes.md`.

## Usage

Run `node scripts/test-schedules.js` (wired into `npm run test:waits`).

## Implementation notes

- Recurrence: a repeating row has `every_ms` (interval) or `spec` (JSON `{time, days, tz}` clock schedule), `runs_left` (NULL = open-ended), `until_at`, and `anchor_at`, the planned slot. `fired()` computes the next slot with `nextSlot()` from the anchor (`anchor + k*every`, or `nextClockSlot()` via `Intl` zone offsets), the first one after *now*, so the grid never drifts and missed slots are skipped. A row past `until_at` is finished by `expire()` without firing. `create()` cancels the chat's existing recurring row (one per chat). The three extra columns are added with `ALTER TABLE` on an older database.
- No overlap: `EALREADY_RUNNING` releases the row for 15 s, and the next slot is computed from the time it finally starts.
- `src/schedules.js`: `wake_schedule` table (created lazily, like `background_job`), `createScheduleStore`, `createScheduler` and `startScheduler`. `src/http-server.js` starts one scheduler per server and stops it on `close`; the ticker (5 s) and the first catch-up tick (1 s) are unref'd.
- Delivery calls `startChatTurn` from `src/server-handlers-chats.js` with the chat's `modelId`/`providerId` and the server `lifecycle`, so it shares busy/cancel/authorization/live-replay behavior with `start_chat`. `EALREADY_RUNNING` releases the row for 15 s without an attempt; other failures go through `store.retry` (30 s x attempts, 3 attempts).
- `lease()` moves `due_at` out by 5 minutes before the turn starts; `fired()` then finalizes. A crash between the two re-fires after the lease: at-least-once, by design.
- New `schedule_wake` calls are time-only and do not accept `jobId`. For backward compatibility only, an already persisted job-linked row (`job_id`, `job_scope`) is a candidate on every tick and fires when `backgroundJobs.get(jobScope, jobId)` is not `running` (a vanished job counts as `lost`). Job scope is the creator's project/chat/invocation, so a nested invocation cannot link to a parent's job.
- `src/tools/schedule.js` holds specs, validation and runners (`createRunners` takes the store, clock, chat lookup so tests drive them). Dispatch is in `src/ai-stream.js`, next to the other native tools; catalog in `src/server-handlers-tools.js`; family leaves in `src/tools/authorization.js` and `frontend/src/toolGroups.js`.
- The store opens through `settings.getDb()`; a test process without `MOUAIF_HOME` makes it throw `ESTORE`, which the scheduler treats as "nothing due".
- A recurring `schedule_wake` calls `openRun` (default `runs.sharedManager().startRecurring`), which opens or re-targets the chat's `kind = 'recurring'` run; `schedule_cancel` of the recurring row calls `closeRecurring`. One-off wakes are still refused with `ERUN_ENDED` once a run has stopped, ended or been exhausted; a new recurring task starts a fresh run.
- Tests: `scripts/test-schedules.js` (real SQLite in a temp home, fake clock and chat runner), plus the recurring sections of `scripts/test-runs.js` and `scripts/test-long-run-e2e.js`.
- Run history: the scheduler passes `origin: { kind: 'schedule', scheduleId, run }` in the `startTurn` body of a recurring run. `startChatTurn` hands it to `runChatStream` as an internal argument (never read from an HTTP body), which stores it on the user message in the `message_store.origin` column (JSON, added with `ALTER TABLE`; `messages.normalizeOrigin` keeps only that shape). `GET /api/chats/:id/runs?projectDir=` returns `[{ seq, ts, run, scheduleId }]` (`chatdb.listScheduledRuns`), and `GET /api/chats/:id/run` adds `scheduledRuns` (the count).
- Frontend: `transcript.js` sets `data-seq` on every persisted row and draws the `Scheduled · run N` badge; `jumpToRun.js` finds a row by seq, pulling older pages (`loadOlderMessages`) until it exists; `scroll.js` `scrollToTranscriptRow` unpins and aligns it; `RunDock.jsx` has the Runs button and list (`runListItems` in `runDock.js`). Tests: `scripts/test-jump-to-run.mjs`, `scripts/test-run-dock.mjs`, the run-history section of `scripts/test-long-run-e2e.js`.
