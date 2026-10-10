# Cooperative subagent group internals

## Overview

The follow-up to Track A `8f0a331f` implements parent-coordinated cooperative metadata and dependency-gated execution in its own isolated branch. It imports no Track E uncommitted files and now supports opt-in rooted recursive delegation (see [recursive internals](recursive-subagent-delegation.md)); no persistent chat/job registry is introduced.

## Usage

See [public contract](../../features/cooperative-subagent-groups.md). Declare the complete group DAG, launch named members with background handles, inspect immediate status, propose decisions/escalate conflicts, and let the parent explicitly approve/arbitrate. Use `subagent_send` for writes; `subagent_messages` is read-only.

```bash
npm run test:subagent-groups
node scripts/test-tool-groups.mjs
```

## Implementation notes

- `src/tools/subagent-groups.js` owns validated immutable member declarations, deferred settlement latches, DAG readiness and transitive blocked propagation. Unknown edges and cycles fail before group insertion; duplicate member launches fail before run insertion. Metadata claims never change filesystem state.
- `src/tools/subagent-orchestration.js` owns eleven control/metadata specs plus the original launch family, turn-scoped groups/artifacts, send receipts, observation budget and bounded shutdown. Waiting uses member latches rather than polling. Failed/cancelled dependency chains wake waiting consumers without running their executors.
- `src/ai-stream.js` retains ordinary approval/agent allowlist gates; child parent-control rejection remains before approval. Group launches require background mode. Child context contains group identity/objective/role/ownership and explicit parent-coordination instructions. Actual workspace is captured separately from the declared workspace. Artifacts contain references, not file reads; authorization/redaction is unchanged.
- Immediate status rejects the old `waitMs` field; read-only messages reject `message`. Explicit sends record queued/delivered/undelivered transitions and return bounded receipts through message reads. Delivered means insertion before a model request, not model acknowledgment.
- Shutdown closes the scope, cancels child approvals/provider requests and waits at most 1,000 ms. Unsettled runs receive exactly one synthetic cancellation result; finalized guards suppress later callbacks/events/billing. No rollback or detached-process kill is attempted. Usage after timeout is a documented limitation.
- `frontend/src/toolGroups.js` and generated mirror list all twelve family leaves (42 native tools). No bespoke UI or REST endpoints: existing generic mobile cards/settings trees render the specs. Matching web build artifacts must ship with this source change.
- Track E `bbc387ca` draft received the immediate status and future bounded wait adapter contract. Its job handles remain independently scoped and unimported. Future adapters must reject self-wait, respect finite deadlines and treat blocked/failed/cancelled readiness explicitly.

## Verification and limitations

`scripts/test-subagent-groups.js` tests cycle/unknown edge rejection without partial effects, out-of-order DAG dispatch, transitive failure/cancel propagation, group completion, immutable proposals/approval, conflict arbitration, artifact discovery/provenance/path validation, parent-only controls, cross-turn isolation, message delivery and undelivery, polling limits and hung-child shutdown/late completion exactly once. `scripts/test-subagent-groups-http.js` additionally exercises real handler/provider member context, artifact provenance, completion, single saved results and disabled file/send-leaf authorization. Existing orchestration HTTP tests cover steering, cancellation during provider I/O/pending approval, normal serving handlers, persistence and billing. Tool-group tests compare catalog, authorization family, mirror and documented counts.

Verified in the isolated follow-up worktree: `npm run test:subagent-groups`, `npm run test:subagent-prompt`, 20 tool-group checks, workspace/serve smoke, authorization-clear-grants, stream-abort, tool-feedback, prompt/snapshot, tools list/toggle/preset, delegated live/total cost, static serving containment/compression, syntax on every touched JavaScript file, `build:web`, responsive app checks including 360 px, docs links and published-site consistency. The full `npm test` was not repeated here: Track A's full run timed out in the existing dictation UI fixture; targeted suites provide the evidence, not a claim of full-suite success. Build warnings remain for a large existing bundle and Node's module-type inference.

Ownership/workspace claims and conflict enforcement are advisory, not locks or automatic checkout selection. Groups are in-memory and parent-turn-local; proposed decisions do not need approval to finish a group, but remain visibly unapproved. Cancellation cannot undo writes. Provider/account billing after forced settlement needs future reconciliation. No merge, push, dependency install or host-server restart is part of this change.
