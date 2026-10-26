# Job tools implementation

## Overview

Implementation notes for `wait_for`, `job_status` and `job_cancel`. User-facing behavior is in `docs/features/job-tools.md`.

## Usage

Run `npm run test:waits`.

## Implementation notes

- `src/tools/jobs.js` holds the specs, validation and the three runners; `src/ai-stream.js` dispatches them next to `group_cli`, and `src/server-handlers-tools.js` lists them in the native catalog under `mouaif`.
- `src/tools/waitTargets.js` builds the observers for `wait_for` targets other than one job: `KINDS.job|chat|subagent|group`, each validating ownership up front and returning an `observe()` the engine polls (1 s). `waits.wait({ observe })` runs a custom target; without one, chat/subagent/group targets are still refused (`EUNSUPPORTED`). Chat state is `runningChats` in `src/server-shared.js`; subagent/group state is read from the turn's `orchestrationScope` (`scope.get`, `scope.groups.status().settled`), so those waits only work inside the delegating turn and by its local parent.
- `wait_for` uses the wait engine in `src/tools/waits.js` (one unreferenced ticker, polls at least 100 ms apart).
- Cancellation lives in `cancelBackgroundJob` in `src/tools/groupCli.js`, which keeps the `jobId` → child map the job registry deliberately does not hold.
- Tests: `npm run test:waits` (includes `scripts/test-job-tools.js`, which runs real background commands).
