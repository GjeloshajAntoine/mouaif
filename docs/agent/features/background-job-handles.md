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

Handles deliberately do not survive worker restart. Public wait/cancel APIs need normal tool gates; a future cancel must report cancellation only after a trusted stop request, not infer it from a signal. No schedule or context boundary ships here.
