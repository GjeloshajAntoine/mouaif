# Job tools implementation

## Overview

Implementation notes for `wait_for`, `job_status` and `job_cancel`. User-facing behavior is in `docs/features/job-tools.md`.

## Usage

Run `npm run test:waits`.

## Implementation notes

- `src/tools/jobs.js` holds the specs, validation and the three runners; `src/ai-stream.js` dispatches them next to `group_cli`, and `src/server-handlers-tools.js` lists them in the native catalog under `mouaif`.
- `wait_for` uses the wait engine in `src/tools/waits.js` (one unreferenced ticker, polls at least 100 ms apart).
- Cancellation lives in `cancelBackgroundJob` in `src/tools/groupCli.js`, which keeps the `jobId` → child map the job registry deliberately does not hold.
- Tests: `npm run test:waits` (includes `scripts/test-job-tools.js`, which runs real background commands).
