# Track E integration contracts and blockers

## Overview

This branch contains independent scoped background-job and bounded-wait foundations, not the four proposed native tools or a schedule. Baseline is committed `6933d3ba`. `f36130f6` identifies the **recursive cooperative groups chat**, not a Git revision; its draft was read through `get_chat`. The correction requires rooted ancestry, root-shared finite budgets, inherited restrictions, subtree cancellation, root-turn lifecycle, exactly-once descendant billing and cycle/self/ancestor-wait rejection. Neither that draft nor another track's uncommitted code is a landed API. The Track E draft coordination note was also read.

## Usage

Run `npm run test:group-cli` and `npm run test:waits`. `src/tools/waits.js` exposes a factory with `wait({ scope, until, timeoutMs, intervalMs, signal })`, nonblocking `check(scope)`, and test hooks. No authorization bypass is exposed through HTTP or native dispatch.

## Implementation notes

### Wait contract

Own timeout ≤240000 ms plus caller abort; no invented turn budget. Terminal observation returns `satisfied: true` with a separate completed/failed/cancelled outcome. Duration expiry is satisfaction. Cancellation removes registry membership and the abort listener, never kills the job. Single unref ticker, max 256 waits, minimum 100 ms polling, no file/log reads. A full registry rejects admission; timeout does not silently prolong polling.

### Recursive Track A/group adapter requirements

Do not import another worktree's uncommitted module. Status/messages must be immediate bounded observations, not nested waits. An eventual target is a structured server-resolved identity `(projectDir, transcriptChatId, parentInvocationId, runId/callId, groupId?, memberId?)`, not a globally resolvable bare call ID. IDs and trusted ancestry must come from dispatch context, not model input.

Before registering a run/group wait, the landed adapter must verify ownership, capture the exact run epoch, reject self and **any ancestor** execution, and reject a dependency/wait graph edge that cycles back to the caller. Checking chat ID alone is insufficient for recursive delegation. A group that contains the caller, or whose completion depends on the caller/its ancestors, cannot be waited on. Fail closed when ancestry or dependencies are unavailable. Current implementation rejects all chat/subagent/group targets with `EUNSUPPORTED`.

Adapter status must distinguish running/dispatching, blocked/unready, completed, failed, cancelled and expired/unknown. Blocked with no runnable dependency must return an explicit unready result, not poll forever. Capture terminal outcomes before registry deletion; require documented retention duration and bounded capacity. Reject late events after shutdown. Renewed waits must not attach to a replacement run. Sibling access requires an explicit group policy; shared transcript identity alone grants no access.

### Chat runs and fresh context

Verified: `src/live-chat.js` allocates random live replay run IDs but deletes them at finish; `src/server-handlers-chats.js:startChatTurn` acknowledges start only, returning no completion identity. Add a separate retained run ledger before chat waits; emit/return its identity, settle all normal/error/abort paths, reject caller/ancestor waits. Do not confuse idle-before-start with completed.

Verified history assembly: `runChatStream` reads all messages, builds current profile/agent files/skills/features/tags/pinned prompt, then calls `messages.reconstructUpstreamHistory`; provider shapes serialize that common history. Proposed fresh-context boundary is a persisted inclusive sequence pointing to the handoff user row. Filter transcript **before** reconstructing tool pairs, attachments and any future summary/compaction. Retain old transcript/trace and current system configuration; never copy previous attachments or summaries across the boundary. Test every provider family, paired tools, failed setup rollback, ordinary continuation and boundary migration before exposing handoff.

### Scheduler contract still blocked

Product decisions required **before** implementation: same chat vs new chat; optional archive vs mandatory archive; model-authored vs standing user prompt; durable schedules vs explicitly ephemeral schedules. No schedule records/timers are shipped. Recommended durable design (not approved): stored unique schedule ID, per-project/chat pending uniqueness, explicit scheduled/deferred/claimed/fired/cancelled/failed/interrupted states, bounded deferrals, persisted terminal outcome and SSE `failed` as well as scheduled/fired/cancelled. Recovery must never silently replay a claimed handoff or turn it into duplicate spend; interrupted claims need a visible failure/reconciliation rule.

Cancel must be an authenticated same-origin POST through `src/http-server.js`'s browser/access gates, validate target project/chat and schedule identity (prevent stale chip cancelling a replacement), and have an atomic claim-vs-cancel race policy. Tool consent must survive scheduling only for the approved target/prompt/delay; reread permissions and chat existence before firing. Reject nested schedule creation. Busy checks include approvals, asks, group/nested runs; a late busy failure is a persisted failed outcome, not an error returned to the old scheduling call. Claim + context boundary + user append must be atomic or rollback-safe; no transcript deletion. Real authentication-on HTTP tests and 360px/44px cancel-chip UI verification remain mandatory.

## Landing coordination and evidence

Shared surfaces currently touched: `src/ai-stream.js` (ownership passthrough only), `package.json`, `docs/README.md`, `CHANGELOG.md`. No tool names/count changes, generated groups, cards or frontend artifacts. Coordinate serial landing after Track A, rebase then rerun tool groups, lint, subagent prompt and docs link tests. Future tools must update every catalog/gate/preset/UI mirror and matching shipped build together, using actual catalog count rather than promised 40. No master changes, merge, push, install or server CLI restart performed.

Verified on this branch: new job/wait suites; existing group CLI, shell (58 checks), chat working-folder serve smoke, tool groups (20 checks), subagent prompt suite, full lint, test-coverage wiring and public/internal docs link checks. New wait tests additionally check abort-listener cleanup on cancellation and completion, expired handle denial and process exit with an unref ticker. Dependencies were reused via `NODE_PATH=/home/ubuntu/mouaif/node_modules`, not installed. Full `npm test`, live-provider handoff, schedule authentication and mobile chip tests were not run; no schedule/UI exists to test yet.
