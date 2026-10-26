# Background job handle implementation

## Overview

Track E's independent prerequisite adds process-local, retained background command identity. No proposed wait/restart tool or Track A/group API is assumed present.

## Usage

Run `npm run test:group-cli`. `group_cli` async entry results and formatted model feedback carry an additive `jobId`.

## Implementation notes

- `src/tools/backgroundJobs.js`: `create/get/list/settle(scope, ...)`, with `scope = { projectDir, chatId, invocationId? }`. Lexical absolute project keys match settings storage. `invocationId` is server context, never model arguments; nested dispatch currently passes the existing `workspaceChatId`. A future recursive invocation ID must replace/bridge this only after its API lands.
- `src/tools/groupCli.js`: reserves metadata before spawn, retains zero/nonzero/spawn/signal outcomes, and removes child references independently. `src/ai-stream.js` passes original project ownership separately from working folder. Normal turn cancellation does not kill detached jobs.
- TTL: one hour from settlement, process-wide hard cap 2,048; reject before spawning at capacity, no early eviction. No timer, output buffer, command or credentials retained. Internal lookup is not an authorization endpoint.
- Tests: scoped denial across project/chat/invocation, unique handles, immutable snapshots, idempotent settlement, retention/cap with fake clock, actual async success/failure, distinct working folder and owner, and observer failure containment. Existing group CLI tests exercise advertisement, dispatcher, authorization, live output and card behavior.
- No shared tool catalog/group/generated UI edits. Landing touches `src/ai-stream.js`, `package.json`, docs index and changelog; rebase serially after Track A and rerun shared suites. No merge/push requested.

## Open issues

Metadata persists in `background_job` (`src/tools/jobStore.js`, write-through from the registry; running rows from another boot become `lost` when a store first opens). The live child handle and the cancel map do not survive a restart, and mouaif still reaps its background children on exit. `wait_for`, `job_status` and `job_cancel` now ship (see `docs/features/job-tools.md`) behind the `mouaif` family gate. `job_cancel` records the stop request itself (`cancelRequested` in `groupCli.js`) and only then settles the job as `cancelled`; a signal alone is still `failed`. No schedule or context boundary ships here.
