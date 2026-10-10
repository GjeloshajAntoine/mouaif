# Recursive subagent delegation

## Overview

Subagents can delegate to children and create/coördinate their own cooperative groups when the root depth budget enables recursion. One root turn owns the entire tree; each local parent controls only its direct children, and conflicts escalate upward without automatic consensus, merges or rollback.

## Usage

Set finite app/project settings before starting a root turn:

```json
{
  "subagentLimits": {
    "maxDepth": 3,
    "maxConcurrent": 4,
    "maxRuns": 32
  }
}
```

Defaults are depth **1**, concurrency **4**, total admitted runs **32**. Depth 1 preserves non-recursive behavior; increase it to opt in. Depth accepts 1–8, concurrency 1–32 and total runs 1–256. Invalid, infinite or non-integer limits reject before execution. Limits are captured at root start; a child cannot reset or increase them.

Use the same `subagent` tool synchronously or with `background:true`. Children inherit the actual advertised parent tool surface, then the selected agent may narrow it. A recursive child can declare a local group using `subagent_group_create`, launch its members and use immediate status, read-only messages, explicit sends, cancellation and contract approval on its own children/groups. Depth-exhausted children do not advertise launch/control tools, and forged launches still hit the depth guard.

## Identity, visibility and escalation

Run receipts/results/status include `rootId`, `parentCallId` and `depth`. Root and each local parent have separate handle/group namespaces; siblings, cousins and ancestors cannot steer or cancel one another. Self/ancestor handles fail with `EDEADLOCK`, foreign handles with `EUNKNOWN_CALL`. Root cancellation is authoritative over the complete subtree.

A member may inspect/propose/conflict in its assigned group, but may approve only groups it created for its own children. `subagent_status({})` lists direct children and bounded descendant conflict escalations. An owning parent or ancestor may arbitrate an explicitly escalated conflict using its group ID/name; this exposes only conflict metadata, not arbitrary descendant groups, transcripts or contracts. Closed local scopes retain escalation metadata until root settlement, not live handles.

Named artifacts are scoped to the producing member's immediate-parent bus. A local parent receives its children's metadata and can explicitly republish a summary upward; there is no automatic all-tree artifact visibility or file transfer. Workspace references remain metadata and never bypass File tools authorization/redaction.

## Permissions and budgets

- Every level uses the real root chat/project authorization identity. Inherited tool names and permission modes cannot widen: disabled/unadvertised tools reject before approval; inherited Ask remains Ask even if a descendant changes settings. Inherited allowlists conservatively require approval rather than silently widening. Current stricter project gates also apply.
- Recursive model selection inherits the executing parent's model. Agent pins that switch models are rejected unless the user explicitly supplies an approval-card override for that launch. Thinking/agent instructions may narrow behavior without granting tools.
- Only explicitly selected image references passed to a parent may be selected again by descendants. Other root-chat attachments cannot be smuggled through `subagent.images`. Ordinary authorized file access remains a separate permission boundary.
- `maxConcurrent` bounds simultaneous delegated **provider requests**, not paused parent frames or detached shell processes. Slots release before tool dispatch, so a synchronous recursive child can run even with concurrency 1; ancestors do not monopolize slots while waiting on children.
- Total admitted runs, eight groups, 64 artifact entries, 64 upward conflict escalations and 256 observation calls are shared across the root tree. Waiting group members consume admission budget, not provider slots. Local dependency DAGs reject cycles/unknown edges; dependencies cannot target ancestor runs or other scopes. Status never waits; there is no ancestor-wait tool.

## Lifecycle and billing

Stopping a child cancels its descendants, queued provider requests and pending approvals, but not unrelated sibling subtrees. A local parent finishing cancels unfinished children; root finishing shuts down the full tree within the existing one-second settlement budget. Each result finalizes once and late callbacks/events cannot reopen it. Cancellation never undoes completed writes or kills deliberately detached commands.

Each descendant's usage/cost travels up its ancestor chain as deltas; ancestor completion adds only an unreported remainder. Live root deltas and final root totals therefore include descendants exactly once. The nested transcript retains recursive results and rooted identities; late billing after forced shutdown remains unreconciled. Handles are in-memory/root-turn-local, not restartable chat jobs.
