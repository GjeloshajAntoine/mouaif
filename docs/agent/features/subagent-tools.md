# Subagent orchestration implementation

## Overview

Track A ships opt-in background nested delegation with a turn-scoped registry, a steering inbox and a metadata-only sibling handoff bus. This deliberately does not create resumable chats or persistent scratchpads.

## Usage

Use `subagent({ task, background: true })`, retain the returned `callId`, then observe with `subagent_status({ callId, waitMs })`, queue guidance with `subagent_messages({ callId, message, since, limit })`, or cancel with `subagent_stop({ callId })`. Parent and children can publish/read named summaries and project-relative file references. Only the parent can control runs.

## Implementation notes

### Contract and scope

- `src/tools/subagent-orchestration.js`: five new specs, `Scope`, random internal child identity, immutable bounded publications and bounded public progress/inboxes.
- `src/ai-stream.js`: the public wrapper owns/cleans one scope per invocation; children inherit that exact object and a private author identity. No process-global handle lookup exists. The parent can control only children in this invocation, including synchronous runs already settled. Child dispatcher rejects parent controls/delegation even if a provider forges a call.
- Launch defaults synchronous. Background launch goes through normal authorization/model resolution and returns a compact actionable receipt. Execution is deferred with `setImmediate`; completion emits the single ordinary `tool_result` under the launch ID. Existing live `subagent_event` and transcript/cost rendering are reused, so no receipt is persisted as a misleading final result.
- Parent normal completion cancels/settles outstanding children before final delegated usage/cost computation. The wrapper finally cleans failure/cancellation paths. Finished entries last until parent completion only.
- Steering is inserted as user-role guidance before the child's next model round. It never aborts/restarts the current provider response. Status can wait at most 30 seconds; it does not start additional execution or widen parallel dispatch.
- `src/tools/authorization.js`: per-call abort listener rejects/removes only that pending approval. Nested wire tool IDs are namespaced by a private random run identity, preventing provider-reused IDs from sharing approvals across siblings. A child stop never calls the shared chat `cancelSession`.
- `src/toolFeedback.js`: preserves background handles and coordination metadata through subagent-specific compaction. `src/messages.js`: pairs delayed subagent results by tool call ID on history reconstruction; ordinary tool results keep adjacency.
- Publish/read has **no** `includeFiles` or `snippets`. References must be relative and cannot traverse `..`; content retrieval belongs to separately authorized File tools. This avoids a new unredacted file-read path. Summaries and answer prose cannot be guaranteed secret-free if the child repeats something it accessed.

### Shared surfaces / landing coordination

Baseline is `d45b1f23`; branch `feat/track-a-subagent-orchestration`. Five names change the native count from 31 to 36, in this order after launch: `subagent_messages`, `subagent_status`, `subagent_stop`, `subagent_publish`, `subagent_read`. Subagent becomes a multi-tool family retaining its original gate/name for compatibility; the launch leaf and family gate share one settings key. Track E must rebase and derive counts from the merged catalog rather than hard-code 40. Tracks C/D should preserve `background`, scope/author plumbing, and the single deferred result lifecycle while editing delegation. Track B must preserve normal approval cancellation and nested event routing.

Changed shared surfaces: `src/prompts.js`, `src/tools/authorization.js`, `src/server-handlers-tools.js`, `src/agentFeatures.js`, `frontend/src/toolGroups.js` and its generated mirror, tool-group tests/docs, docs index/reference and changelog. No approval-card component changes are needed. Rebuild committed web assets from the matching sources at landing; do not mix another track’s bundle. No automatic merge, push or host-server restart.

### Verification and limitations

`scripts/test-subagent-orchestration.js` exercises scoped handle isolation, bounded slices, inbox delivery, immutable handoffs, role separation, stop idempotence, sibling approval isolation, HTTP background steering, cancellation during provider I/O and approval, turn-end cleanup, final-result persistence and delegated usage. Verified: subagent prompt/image/transcript suite, delegated cost/live-cost/progress tests, tool-group and mirror agreement, authorization/clear-grants, feedback/history, prompt snapshot/profiles/cache, routes/static containment/compression, lint and touched-file syntax checks, web build, docs builds/links/publication parity, test wiring, mobile tool-tree at 360–1280 px and responsive app browser tests. Existing dependencies were reused via an untracked symlink; none were installed.

Full `npm test` did not finish: it reached the existing `test-dictation-ui.mjs` fixture server and exceeded 10 minutes; the fixture process was stopped, not the app. `test-subagent-transcript-ui.mjs` likewise opened its fixture server without finishing under its default invocation and was stopped. Automated DOM transcript tests and independent mobile browser tree/app tests passed. No claim of a complete full-suite pass or live-provider/host-server exercise.

Background status intentionally returns bounded answer text, not raw transcript/tool payloads or pixels. Full results remain saved in the nested card; synchronous delegation remains the image/vision path. Cancellation remains cooperative and cannot undo already-completed writes or kill deliberately detached shell processes. No live-provider catalog/model-policy change is included.
