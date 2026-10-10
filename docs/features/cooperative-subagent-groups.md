# Cooperative subagent groups

## Overview

A cooperative group gives turn-scoped subagent work a shared objective, declared members and dependency readiness. Each local parent coordinates its own children and approves only its own group contracts. Recursive delegation is opt-in, rooted in one finite-budget run tree; conflicts can escalate upward to the root. No automatic consensus, merges or rollback.

## Usage

Create a group before launching its members:

```json
{
  "name": "parser-change",
  "objective": "Implement and review a compatible parser contract",
  "members": [
    { "memberId": "contract", "role": "Design API", "owns": ["src/parser.js"], "workspace": "feat/parser-contract" },
    { "memberId": "review", "role": "Review implementation", "workspace": "feat/parser-review", "dependsOn": ["contract"] }
  ]
}
```

Pass this to `subagent_group_create`. Retain its `groupId`, then launch each declared member through the ordinary authorized `subagent` tool:

```json
{ "task": "Review the parser contract", "background": true, "groupId": "group-returned-id", "memberId": "review" }
```

The member is admitted once. It waits without a provider/tool request until every dependency completes successfully. Members may be launched in any order; never-launched dependencies remain pending until launched or cancelled. Unknown dependencies and cycles reject the entire declaration before it creates state. Failed/cancelled dependencies transitively block consumers; there is no retry or automatic rollback.

### Status and artifacts

`subagent_group_status({ groupId })` returns the objective, members, readiness, artifacts, decisions and conflicts immediately. The parent may omit `groupId` to list groups; children may omit it to inspect their own group only. Member metadata includes role, ownership references, declared workspace, call ID and actual execution workspace when known. Workspace claims are advisory: they do not prepare/select a checkout or lock files. Use separately authorized workspace/file/shell tools for actual work.

`subagent_publish({ name, summary, files })` creates an immutable named artifact. `subagent_read({})` discovers accessible artifacts; provide `name` to read one. Artifact records include author, member, group and execution-workspace provenance. File references are relative metadata only: reading their contents still requires ordinary File tools authorization and redaction. References from another workspace are never silently resolved against the reader's directory.

### Decisions and conflicts

- `subagent_decision({ groupId, name, proposal })` creates an immutable named **proposal**, not an approved contract.
- Only `subagent_group_update({ groupId, action: "approve", name, contract })` establishes the parent's approved contract. `action: "reject"` records a rejection reason in `contract` instead.
- `subagent_conflict({ groupId, name, summary, members })` escalates a conflict among known members. An open conflict makes group status blocked, including after all members finish.
- Only the parent resolves it using `subagent_group_update({ groupId, action: "arbitrate", name, contract })`. Arbitration records a resolution; it never edits, merges or restarts members. Conflicts are an explicit coordination signal, not an automatic filesystem lock or interrupt.
- `subagent_group_update({ groupId, action: "cancel" })` cancels outstanding members and their approvals. Completed work remains completed; dependency consumers become blocked. Cancelled groups cannot admit cancelled members later.

Group state is `pending`, `running`, `completed`, `blocked`, `failed` or `cancelled`. Failure/cancellation takes precedence over blocked. `settled` means every member has a terminal outcome, while `complete` requires every member to succeed and no open conflict. An unlaunched member prevents success. A proposal alone never becomes an approved decision by consensus or successful completion.

### Messages and waiting

`subagent_messages` only reads bounded public progress/answer lines and message delivery receipts. Explicit `subagent_send({ callId, message })` is parent-only and returns a `messageId` with `queued`, `delivered` or `undelivered` status. Delivered means inserted as guidance before the child's next model round—not acknowledged or obeyed. Settlement/cancellation makes queued messages undelivered; sending to an already finished child returns undelivered.

Status does not wait and rejects `waitMs`. Observation tools share a 256-call turn budget (`EPOLL_LIMIT`); avoid tight polling. There is no new wait tool. Future Track E waits must use scoped handles, bounded deadlines/poll budgets and self-wait rejection, not hide waiting inside status.

## Limits and permissions

All twelve Subagent-family functions retain the existing gate and per-leaf overrides. Child-visible metadata/proposal tools still honor the parent's tool selection and the agent allowlist; forged cross-scope and ancestor controls fail before approval. No new REST endpoint, persistent scratchpad, consensus process, automatic merge or rollback is added. See [Recursive delegation](recursive-subagent-delegation.md) for opt-in nested child/group controls and root-shared budgets.

Limits: eight groups per turn, 32 members per group, 32 delegations total by default (configurable root budget), 64 decisions/conflicts per group, 64 artifacts per turn, 64 send receipts per child, 16 queued messages, and 256 observation calls. Handles disappear when the parent turn ends or the worker restarts. Shared summaries and model prose are not a secrecy boundary.

Shutdown cancels outstanding children and waits at most one second. Non-cooperative children finalize once with `ESHUTDOWN_TIMEOUT`; late public events, publications and results cannot reopen them. Cancellation cannot undo existing writes or kill deliberately detached commands. Usage arriving after the shutdown deadline is not reconciled; saved ordinary nested tool cards remain the historical record.
