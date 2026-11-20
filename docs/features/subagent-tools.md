# Subagent orchestration

## Overview

Delegate isolated, throwaway work without blocking the parent’s ability to observe or steer it. Background handles, controls and sibling handoffs belong to one parent turn; use real chats for independently resumable delegation.

## Usage

Enable the **Subagent** tool family and select the needed tools in the chat. Existing approvals, model overrides, named-agent pins, explicit image selection and tool restrictions still apply. Ordinary `subagent` calls wait for completion unless `background` is true.

```json
{ "task": "Review the parser; publish findings as parser-review", "background": true }
```

The result immediately supplies a `callId`, `background: true` and `state: "running"`. In a chat, the handle is **chat-scoped, not turn-scoped**: it stays valid in every later turn of the same chat until the run settles or is stopped, so you can start work in one turn and poll, steer or stop it in the next. (One-shot callers without a chat — tests, the direct REST endpoint, the shell reviewer — keep the old turn-local behaviour: the handle dies with the call.)

- `subagent_status` immediately lists runs, or accepts `callId` for one row. It never waits; `waitMs` is rejected. Observation calls share a finite 256-call turn budget; do not poll tightly. Rows include agent, resolved model ID when known, state, elapsed time, latest line, publication names and a bounded final answer/error.
- `subagent_messages` accepts `callId`, numeric `since` cursor and `limit` (1–50, default 20). It returns public answer/progress lines and a `nextCursor`. `truncated` means older lines have fallen out of the window: it is measured from the highest cursor actually evicted, so a coalesced first line does not report a truncation that never happened. Consecutive message deltas coalesce up to 2048 characters into one line; a delta that would overrun the cap is dropped rather than split into invented lines, so a line's text is always what the child said. This tool is read-only; `message` is rejected. Delivery receipts appear separately from public lines.
- **Steering reaches the child's next request** — a queued `subagent_send` is drained into the model context before each request *and* before a retry of a transient upstream failure, so guidance is not lost to a retry that already had the old context. A `progress_update` is attributed to the run whose `parentCallId` it names, so a nested child's progress cannot land on a sibling's card.
- `subagent_send({ callId, message })` explicitly queues parent guidance for the next child request; it does not interrupt an active provider request or approval. Receipts transition from `queued` to `delivered` when inserted into model context, or `undelivered` when the child settles/cancels. Delivered does not mean obeyed.
- `subagent_stop` cancels one child and its pending tool approvals without cancelling siblings. Repeated stops are safe; `alreadyFinished` reports settled runs. Cancellation is cooperative, not rollback: earlier tool side effects remain.
- `subagent_publish` stores `{ name, summary, files? }`. Names are immutable within the turn, so use a new name for a revision. The parent and sibling children can publish/read; the publication records its author.
- `subagent_read` reads a named handoff. File entries are project-relative references, **not file contents**. Resolve them using ordinary authorized File tools and their redaction rules. There is no automatic file read or arbitrary snippet transport.

```json
{ "callId": "call_review", "message": "Focus on cancellation races" }
```

```json
{ "callId": "call_review", "since": 0, "limit": 20 }
```

```json
{ "name": "parser-review", "summary": "Two cancellation races need tests", "files": ["src/ai-stream.js"] }
```

Only the parent can list, message or stop runs. Children see publish/read and their group's status/proposal/conflict tools when those names survive the parent’s tool selection and the selected agent’s allowlist; at the default depth limit they do not see delegation or local-parent controls. Increasing the root depth budget enables those inherited controls for their own children only.

### Cooperative groups

See [Cooperative subagent groups](cooperative-subagent-groups.md) for objective/member declarations, dependency readiness, workspace-aware artifact discovery, proposed versus parent-approved contracts, conflicts and arbitration. Each local parent coordinates its own children; nested subagents can delegate further by default ([recursive delegation](recursive-subagent-delegation.md), depth 3, shared finite root limits).

### Visual structure and communication schemas

Expanded Subagent orchestration tool cards (`subagent_group_create`, `subagent_group_status`, `subagent_group_update`, `subagent_status`, `subagent_messages`, `subagent_send`, `subagent_stop`, `subagent_publish`, `subagent_read`, `subagent_decision`, `subagent_conflict`) and complex `subagent` runs that coordinate child workers or group handoffs automatically render a responsive SVG schema diagram (`frontend/src/mermaid.js` + `frontend/src/components/chat/toolRender.js`) above the structured details:

- **Group & worker topology** (`flowchart TD` / `flowchart LR`) showing parent coordinators, group subgraphs, member states, `dependsOn` edges, published handoff artifacts, proposals, and escalated conflicts.
- **Inter-agent message flows** (`sequenceDiagram`) showing parent-to-worker task delegation, `subagent_send` steering receipts, `subagent_messages` progress/output lines, decision proposals, and stop signals.
- Every schema diagram is wrapped in a tap-to-zoom button for the full-screen mobile lightbox and includes a collapsible **Schema source** disclosure.

### Ending the turn

In a chat, ending the parent turn no longer cancels unfinished background children: the chat's orchestration scope is long-lived, so a `background: true` run keeps running across turns and its handle stays controllable (`subagent_status` / `subagent_messages` / `subagent_send` / `subagent_stop`) from any later turn of the same chat. Its final `tool_result` is persisted as an ordinary transcript row when it settles — even if the turn that started it has already ended — so the call card settles on the next reconcile instead of staying on "running". A run is ended only by settling, an explicit `subagent_stop`, the chat's deletion, or a worker restart/shutdown (which cancels every chat's runs with the usual one-second settlement budget; a non-cooperative child then receives a single synthetic cancelled result, `ESHUTDOWN_TIMEOUT`, and later events cannot reopen it). Nothing can be controlled from another chat, even with a copied handle. Turn-local scopes (one-shot callers without a chat) keep the old behaviour: ending the turn cancels unfinished children and discards handles, inboxes and handoffs. Saved transcripts remain ordinary chat tool cards either way.

Live updates from a background subagent belong to the turn that launched it. If the owner disconnects while that turn is still running, followers can keep watching. After the turn ends, use `subagent_status` or `subagent_messages` to check progress; the old turn's live frames aren't replayed into a later turn. The final result is saved even if a later turn is already running.

The background call card stays running until its **single final result** arrives, with the same nested conversation and cost rendering as a synchronous call. While a `subagent` card is running, it stays pinned at the bottom of the chat transcript (below any new parent or sibling messages, tool calls, progress updates, and live streaming text, and above mounted MCP App cards and active approval/question overlays); once its final result arrives, it returns to its original chronological slot in the conversation. The parent receives a bounded text answer through status; generated image pixels are not automatically inserted into its live background-result context. Prefer synchronous image delegation when the parent needs immediate vision content.

### Card model and context line

An expanded subagent card ends with a muted footer line, `model · context N` (e.g. `gpt-5 · context 14.8K`): which model the delegated run used and how large its context grew by the final round. The model id arrives with the live `start` frame and each `usage_update`; the context size is the settled result's last `usage.promptTokens` (every round re-sends the conversation, so the last report is the run's final context). The card head separately shows the running delegated cost.

## Retry behavior

When a subagent fails, its card and the bottom notice show the reason and offer **Retry**. Retrying asks the parent model to delegate the same task again. It is treated as an explicit retry request, so any unrelated text or attachments already in the composer remain untouched.

## Limits and permissions

- All twelve names resolve through the existing `tools.subagent` gate, with the normal family/per-leaf authorization behavior. No new permission bypass or REST endpoint is added. Direct composer `@agent` remains synchronous.
- A turn admits at most 32 delegations and 64 publications. Each child has 128 public polling entries, each at most 2,048 characters; its inbox has at most 16 messages of 4,096 characters. Final status text is capped at 16,384 characters. Summaries are capped at 8,192 characters and file references at 20 entries.
- Polling never copies reasoning, raw tool results, shell output, images or file bodies. Model-written prose is not a secrecy boundary: an assistant can repeat information it already accessed, as with ordinary chat answers.
- Unknown handles return `EUNKNOWN_CALL`; unknown handoffs return `EUNKNOWN_PUBLICATION`. Handoffs cannot overwrite an existing name (`EEXISTS`). This is a coordination bus, not a persistent scratchpad.
- Successive background starts already overlap; mixed control/file/shell batches keep sequential dispatch. The existing parallel path applies only when every call is exactly `subagent`.
- A chat's background runs share the chat's root budgets (`subagentLimits.maxRuns`, groups, publications, observation budget) across **all its turns**, not just one: the budget is charged when a run is admitted and stays charged after the turn ends, so a long-lived scope cannot accumulate unbounded runs. Depth and per-agent caps are unchanged.
