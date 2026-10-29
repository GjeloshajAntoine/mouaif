# Bounded wait foundation

## Overview

An internal wait engine supports finite delays and observation of scoped background command completion. This foundation does **not** enable `wait_for` or `wait_check` in chat; their complete authorization and target adapters remain integration work.

## Usage

There is no new composer command or public API. Continue using `group_cli` and its returned log path for background execution. Maintainers can test the engine with `npm run test:waits`.

## Behavior and limits

- Each wait has its own timeout, capped at four minutes, and observes the caller's abort signal. No total assistant-turn deadline exists or is added here.
- A duration finishing is satisfied, not timed out. A shell wait is satisfied when its captured job settles; `outcome` separately identifies completed, failed or cancelled. Satisfaction does not imply command success.
- Cancellation is distinct from timeout. It removes the wait and abort listener; cancelling observation does not stop the detached command.
- One unreferenced ticker services at most 256 pending waits and stops when empty. Polls occur at least 100 ms apart. No output/log buffers are retained or read.
- Job observations require the owning project, chat and nested invocation identity. Unsupported chat, subagent and group targets are refused rather than guessing that an idle chat or missing child means success.
- Like background handles, pending observations are process-local and do not survive app restart.

See [Background job handles](background-job-handles.md) for retention and scope.
