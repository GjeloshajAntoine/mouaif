# Subagent orchestration

## Overview

Delegate isolated, throwaway work without blocking the parent’s ability to observe or steer it. Background handles, controls and sibling handoffs belong to one parent turn; use real chats for independently resumable delegation.

## Usage

Enable the **Subagent** tool family and select the needed tools in the chat. Existing approvals, model overrides, named-agent pins, explicit image selection and tool restrictions still apply. Ordinary `subagent` calls wait for completion unless `background` is true.

```json
{ "task": "Review the parser; publish findings as parser-review", "background": true }
```

The result immediately supplies a `callId`, `background: true` and `state: "running"`. Keep that handle within the current turn:

- `subagent_status` immediately lists runs, or accepts `callId` for one row. It never waits; `waitMs` is rejected. Observation calls share a finite 256-call turn budget; do not poll tightly. Rows include agent, resolved model ID when known, state, elapsed time, latest line, publication names and a bounded final answer/error.
- `subagent_messages` accepts `callId`, numeric `since` cursor and `limit` (1–50, default 20). It returns public answer/progress lines and a `nextCursor`. `truncated` means older lines have fallen out of the window. This tool is read-only; `message` is rejected. Delivery receipts appear separately from public lines.
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

### Ending the turn

Completed runs remain observable until the parent finishes. Ending the parent turn cancels unfinished children and waits at most one second for settlement, then discards handles, inboxes and handoffs. A non-cooperative child receives a single synthetic cancelled result (`ESHUTDOWN_TIMEOUT`); later events/results cannot reopen it. Billing after that deadline is not attributed. Parent cancellation or failure also cleans up children. Nothing can be controlled from another chat or later turn, even with a copied handle. Worker restart loses this in-memory coordination state; saved transcripts remain ordinary chat tool cards.

The background call card stays running until its **single final result** arrives, with the same nested conversation and cost rendering as a synchronous call. The parent receives a bounded text answer through status; generated image pixels are not automatically inserted into its live background-result context. Prefer synchronous image delegation when the parent needs immediate vision content.

## Limits and permissions

- All twelve names resolve through the existing `tools.subagent` gate, with the normal family/per-leaf authorization behavior. No new permission bypass or REST endpoint is added. Direct composer `@agent` remains synchronous.
- A turn admits at most 32 delegations and 64 publications. Each child has 128 public polling entries, each at most 2,048 characters; its inbox has at most 16 messages of 4,096 characters. Final status text is capped at 16,384 characters. Summaries are capped at 8,192 characters and file references at 20 entries.
- Polling never copies reasoning, raw tool results, shell output, images or file bodies. Model-written prose is not a secrecy boundary: an assistant can repeat information it already accessed, as with ordinary chat answers.
- Unknown handles return `EUNKNOWN_CALL`; unknown handoffs return `EUNKNOWN_PUBLICATION`. Handoffs cannot overwrite an existing name (`EEXISTS`). This is a coordination bus, not a persistent scratchpad.
- Successive background starts already overlap; mixed control/file/shell batches keep sequential dispatch. The existing parallel path applies only when every call is exactly `subagent`.
