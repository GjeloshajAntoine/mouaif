# Scheduled wakes implementation

## Overview

Implementation notes for `schedule_wake`, `schedule_list` and `schedule_cancel`. User-facing behavior is in `docs/features/scheduled-wakes.md`.

## Usage

Run `node scripts/test-schedules.js` (wired into `npm run test:waits`).

## Implementation notes

- `src/schedules.js`: `wake_schedule` table (created lazily, like `background_job`), `createScheduleStore`, `createScheduler` and `startScheduler`. `src/http-server.js` starts one scheduler per server and stops it on `close`; the ticker (5 s) and the first catch-up tick (1 s) are unref'd.
- Delivery calls `startChatTurn` from `src/server-handlers-chats.js` with the chat's `modelId`/`providerId` and the server `lifecycle`, so it shares busy/cancel/authorization/live-replay behavior with `start_chat`. `EALREADY_RUNNING` releases the row for 15 s without an attempt; other failures go through `store.retry` (30 s x attempts, 3 attempts).
- `lease()` moves `due_at` out by 5 minutes before the turn starts; `fired()` then finalizes. A crash between the two re-fires after the lease: at-least-once, by design.
- New `schedule_wake` calls are time-only and do not accept `jobId`. For backward compatibility only, an already persisted job-linked row (`job_id`, `job_scope`) is a candidate on every tick and fires when `backgroundJobs.get(jobScope, jobId)` is not `running` (a vanished job counts as `lost`). Job scope is the creator's project/chat/invocation, so a nested invocation cannot link to a parent's job.
- `src/tools/schedule.js` holds specs, validation and runners (`createRunners` takes the store, clock, chat lookup so tests drive them). Dispatch is in `src/ai-stream.js`, next to the other native tools; catalog in `src/server-handlers-tools.js`; family leaves in `src/tools/authorization.js` and `frontend/src/toolGroups.js`.
- The store opens through `settings.getDb()`; a test process without `MOUAIF_HOME` makes it throw `ESTORE`, which the scheduler treats as "nothing due".
- Tests: `scripts/test-schedules.js` (real SQLite in a temp home, fake clock and chat runner).
