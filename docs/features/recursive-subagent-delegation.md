# Recursive subagent delegation

## Overview

Subagents can delegate to their own nested subagents and create/coördinate their own cooperative groups by default, bounded by a finite root depth budget. One root turn owns the entire tree; each local parent controls only its direct children, and conflicts escalate upward without automatic consensus, merges or rollback.

## Usage

Recursion works out of the box. Two budgets, shared by one turn and every subagent below it, bound it:

| Setting | Default | Minimum | What it limits |
| --- | --- | --- | --- |
| `subagentLimits.maxDepth` | 3 | 1 | How many levels of subagents may stack. `1` turns nesting off: subagents cannot start their own. |
| `subagentLimits.maxRuns` | 32 | 1 | How many subagents one turn may start in total, at every level together. |

With the defaults, the root's child and grandchild can each launch subagents, and the depth-3 leaf cannot. With `maxDepth: 1`, children do not see the launch and control tools, and the `subagent` tool description no longer tells the model that subagents can delegate; at any other depth the description states the configured number of levels.

### Per-agent limits

Each agent, the default subagent included, has **Subagent limits** in its editor (Settings → Agents → the agent). They apply to the subagents that agent starts, at every level below it:

| Field | Stored as | Minimum | What it limits |
| --- | --- | --- | --- |
| Nesting | `maxNesting` | 0 | Levels of subagents below the agent. `0`: it cannot start subagents and does not see the launch and control tools. |
| Total | `maxRuns` | 1 | Runs its subtree may start in all. |

An empty field sets nothing: only the limits of whoever launched the agent apply. An agent's limits never loosen the limits above it: a launch must fit every one of them. There is no maximum; a negative or non-whole value is refused when the agent is saved.

### Turn-wide limits

`subagentLimits` (the first table) bounds the whole turn, above every agent. It has no editor field; set it in the project's `.mouaif.json`, with `PUT /api/settings/app` or `PUT /api/settings/project`, or by asking the assistant (`update_settings`):

```json
{
  "subagentLimits": {
    "maxDepth": 3,
    "maxRuns": 32
  }
}
```

A project value overrides the app value field by field: a project that sets only `maxDepth` keeps the app's `maxRuns`. A write replaces the whole `subagentLimits` object of its scope, so send every field you want that scope to keep.

### Validation

Each limit must be a whole number of at least 1; there is no maximum. `PUT /api/settings/app`, `PUT /api/settings/project` and the `update_settings` tool all refuse anything else and write nothing:

```text
subagentLimits.maxDepth must be a whole number of at least 1
```

A hand-edited `.mouaif.json` is not checked when it is saved. If it holds an invalid limit (`"maxDepth": "3"`, `0`, `2.5`), turns in that project still run: the invalid field uses its built-in default (not the app-wide value), the valid fields are kept, and the server log gets one warning that names the project, the bad value and the number used instead:

```text
[mouaif] invalid subagentLimits in the settings of /path/to/project: maxDepth = "3" (using 3). Each limit must be an integer: maxDepth ≥ 1, maxRuns ≥ 1.
```

Limits are read when a root turn starts; a change applies from the next message, and a child cannot reset or increase them.

Use the same `subagent` tool synchronously or with `background:true`. Children inherit the actual advertised parent tool surface, then the selected agent may narrow it. A recursive child can declare a local group using `subagent_group_create`, launch its members and use immediate status, read-only messages, explicit sends, cancellation and contract approval on its own children/groups. Depth-exhausted children do not advertise launch/control tools, and forged launches still hit the depth guard.

## Identity, visibility and escalation

Run receipts/results/status include `rootId`, `parentCallId` and `depth`. Root and each local parent have separate handle/group namespaces; siblings, cousins and ancestors cannot steer or cancel one another. Self/ancestor handles fail with `EDEADLOCK`, foreign handles with `EUNKNOWN_CALL`. Root cancellation is authoritative over the complete subtree.

A member may inspect/propose/conflict in its assigned group, but may approve only groups it created for its own children. `subagent_status({})` lists direct children and bounded descendant conflict escalations. An owning parent or ancestor may arbitrate an explicitly escalated conflict using its group ID/name; this exposes only conflict metadata, not arbitrary descendant groups, transcripts or contracts. Closed local scopes retain escalation metadata until root settlement, not live handles.

Named artifacts are scoped to the producing member's immediate-parent bus. A local parent receives its children's metadata and can explicitly republish a summary upward; there is no automatic all-tree artifact visibility or file transfer. Workspace references remain metadata and never bypass File tools authorization/redaction.

## Permissions and budgets

- Every level uses the real root chat/project authorization identity. Inherited tool names and permission modes cannot widen: disabled/unadvertised tools reject before approval; inherited Ask remains Ask even if a descendant changes settings. Inherited allowlists conservatively require approval rather than silently widening. Current stricter project gates also apply.
- Below the root, a subagent runs on the model of the subagent that launched it:
  - A nested `subagent` call that names no `agent` always uses its parent's model. The default subagent's instructions, tool list and thinking level still apply; its model pin and the chat or project subagent-model defaults do not (they apply to launches made by the root chat, as before).
  - A nested call that names an agent runs only when that agent resolves to the parent's model. If its pin (or, without a pin, the chat or project subagent-model default) selects another model, the launch is refused with `EDENIED`, unless the user picks a model on that launch's approval card.
  - Launches made by the root chat are unchanged: approval-card choice, then the agent's pin, then the chat default, then the project default, then the chat model.
- Only explicitly selected image references passed to a parent may be selected again by descendants. Other root-chat attachments cannot be smuggled through `subagent.images`. Ordinary authorized file access remains a separate permission boundary.
- There is no limit on how many subagents call the model at the same time; only depth and total runs are bounded.
- Total admitted runs, eight groups, 64 artifact entries, 64 upward conflict escalations and 256 observation calls are shared across the root tree. Waiting group members consume admission budget. Local dependency DAGs reject cycles/unknown edges; dependencies cannot target ancestor runs or other scopes. Status never waits; there is no ancestor-wait tool.

## Lifecycle and billing

Stopping a child cancels its descendants, in-flight provider requests and pending approvals, but not unrelated sibling subtrees. A local parent finishing cancels unfinished children; root finishing shuts down the full tree within the existing one-second settlement budget. Each result finalizes once and late callbacks/events cannot reopen it. Cancellation never undoes completed writes or kills deliberately detached commands.

Each descendant's usage/cost travels up its ancestor chain as deltas; ancestor completion adds only an unreported remainder. Live root deltas and final root totals therefore include descendants exactly once. The nested transcript retains recursive results and rooted identities; late billing after forced shutdown remains unreconciled. Handles are in-memory/root-turn-local, not restartable chat jobs.
