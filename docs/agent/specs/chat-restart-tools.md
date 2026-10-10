# Spec — long-running wait tools and scheduled chat restarts

> Maintainer design proposal for **Track E** of [the parallel development plan](../plans/parallel-development.md).
> Not build-ready: stable job/run handles, context boundaries, restart persistence, and
> authorization/cancellation surfaces must be designed before implementation.
> Same rules as every track: one feature = one commit, Conventional Commits, mobile-first UI,
> a `docs/features/<slug>.md` page plus its `docs/README.md` line, and the matching
> `docs/agent/features/<slug>.md` notes in the same commit.

## Track E implementation status

The independent job-handle and internal bounded-wait foundations are documented in
[Track E integration contracts](../features/track-e-integration.md). No four-tool catalog or
schedule is enabled. The proposal below still contains superseded turn-budget assumptions:
there is **no total turn deadline**; implemented waits use their own cap plus caller abort.
Recursive delegation requires scoped invocation/run/group identity and rejection of self,
ancestor and dependency-cycle waits before adapters can be exposed. Track A/group APIs are
not assumed landed. Context boundary, schedule durability, authenticated cancellation and
persisted failed outcomes remain gating work and product decisions.

## 1. Purpose and the problem being solved

Two operational gaps in long autonomous runs:

1. **A wait with something to do.** An agent that started a background build, an MCP job, or a
   delegated subagent has no way to wait for it that is not *idle*. `group_cli` can start a
   background command but returns immediately; the model's only options are to poll with `shell`
   (burning tokens and turns) or to guess. There is no `wait` tool today.
2. **Long runs outlive their chat.** A chat that runs for hours accumulates provider context, a
   growing transcript, and cost. Splitting one long autonomous run into successive short runs
   keeps the context window small and the transcript readable, but nothing can schedule
   "continue this work in a fresh context".

Track E therefore adds **two families**:

- **`wait` family** — `wait_for` (block on a condition or process, bounded) and `wait_check`
  (non-blocking peek at the tools that can finish later).
- **`chat_restart` family** — `chat_restart` (one scheduled fresh-context handoff) and
  `chat_restart_stop` (cancel a pending one). The periodic/interval mode is documented as
  deliberately *not* built yet (§7).

Both families are ordinary native tools: same approval card, same `tool_call` / `tool_result`
events, same Off / Ask / Allow gate.

## 2. Proposed constraints and missing prerequisites

The current stream loop has cancellation and provider idle timeout handling, not a total
turn-budget deadline exposed to tools. Introduce an explicit deadline policy if wanted;
otherwise bound waits by their own timeout and the turn's abort signal. An unref'd timer
permits process exit; it does not guarantee cleanup or cancellation. Every wait needs abort
listeners, bounded reads, and deterministic registry removal.

Restarting the same chat with fresh context requires a persisted context-start sequence
(or equivalent epoch) used by all provider-history builders. Do not delete history. Define
how system prompts, tool results, attachments, summaries, and context compaction cross that
boundary. Today `start_chat` alone does not reset context.

Authorize the target chat in the calling project, isolate records by project and chat,
and refuse self-chat waits that would deadlock the calling turn. Define whether schedules
survive app restart (durable records) or are explicitly ephemeral. Scheduling cannot return
an `EBUSY` error ten minutes later: emit a terminal failed event and persist the outcome.
A cancel chip needs an authenticated endpoint; a transcript row is visibility, not consent.

- **No block may outlive its turn.** `wait_for`'s `timeoutMs` is clamped to 240000 (4 min) and the
  effective deadline is `min(timeoutMs, time left in the turn)`. A wait that would exceed the turn
  deadline returns `{ ok: true, satisfied: false, timedOut: true, reason: 'turn-budget' }` and the
  model decides again. A zombie turn is worse than an unwaited job.
- **No unbounded in-memory buffers.** Timed waits are tracked in a single `setInterval` ticker
  registry (one interval for every wait, `.unref()`ed), never one `setTimeout` per call. The
  condition poller keeps a bounded tail per wait.
- **A restart never runs while an assistant turn is open.** The scheduler fires only when the chat
  is idle (last turn settled, no pending tool call, no open subagent run). If the chat is still
  busy at the due time, the scheduler defers and re-checks; it never interrupts a live turn.
- **A restart is one opt-in schedule per chat, and it is always visible.** Never a silent loop.

## 3. Proposed tool contracts

### 3.1 `wait_for` — the wait family's leaf

```json
{
  "name": "wait_for",
  "arguments": {
    "until": "shell:<jobId>|subagent:<callId>|file:<relPath>|log:<relPath>|chat:<chatId>|duration",
    "contains": "optional literal the output must contain (shell/log targets)",
    "changed": true,
    "timeoutMs": 180000,
    "intervalMs": 5000,
    "reason": "waiting for the build to print 'done'"
  }
}
```

| `until` | satisfied when |
|---|---|
| `shell:<jobId>` (revised proposal) | a new scoped job registry retains that stable job's terminal state; the existing child Set is insufficient |
| `subagent:<callId>` | the delegated run (Track A's registry) reaches a terminal state |
| `file:<relPath>` | the file exists, or its `mtimeMs`/size changed since the call (`changed: true`) |
| `log:<relPath>` | the `.mouaif/logs/<file>` has grown past its size at call time, and, when `contains` is set, the appended text contains that literal |
| `chat:<chatId>` | a captured run ID has settled; reject the calling chat and distinguish failure/cancellation from success |
| `duration` | the requested delay elapsed: return satisfied, not timedOut; cancellation remains distinct |

Result (one shape for every target, so the model has one thing to read):

```json
{
  "ok": true,
  "satisfied": true,
  "timedOut": false,
  "waitedMs": 4210,
  "polls": 1,
  "target": "shell:job-123",
  "detail": { "exitCode": 0, "tail": "…last 20 lines…" },
  "checked": { "subagentRuns": 2, "backgroundCommands": 1 }
}
```

On timeout: `{ ok: true, satisfied: false, timedOut: true, reason: "timeout" | "turn-budget" }` —
a timeout is **not** an error (no `ETIMEDOUT`), because the model is expected to keep working.
Typed errors only for bad input: `EBADINPUT` (unknown/blank `until`), `ETOOL_DISABLED`
(`off` mode), `ENOTARGET` (a `shell`/`subagent` handle that no longer exists).

### 3.2 `wait_check` — the non-blocking peek

```json
{ "name": "wait_check", "arguments": {} }
```

Returns, in one call, what a renewed wait could act on — the cheapest way to end the
"wait → timed out → wait again" loop with information instead of another poll:

```json
{
  "ok": true,
  "backgroundCommands": [{ "label": "npm run build", "cmd": "npm run build", "running": true, "elapsedMs": 61000, "log": ".mouaif/logs/…log", "tail": "…3 lines…" }],
  "subagentRuns": [{ "callId": "…", "agent": "reviewer", "state": "running", "elapsedMs": 12000 }],
  "pendingRestarts": [{ "chatId": "…", "dueAt": "…", "mode": "handoff", "prompt": "…" }],
  "counts": { "backgroundCommands": 1, "subagentRuns": 1, "pendingRestarts": 0 }
}
```

### 3.3 `chat_restart` — the restart family

```json
{
  "name": "chat_restart",
  "arguments": {
    "chatId": "optional; defaults to the calling chat",
    "mode": "handoff",
    "delayMs": 60000,
    "prompt": "Mandatory for `handoff`: the message the new turn starts from.",
    "untilIdle": true
  }
}
```

Proposed semantics (subject to the prerequisites in §2):

- **`mode: "handoff"` (the only mode shipped).** At the due time, if the chat is idle:
  1. the current turn's transcript is optionally archived to
     `<projectDir>/.mouaif/restarts/<chatId>-<ts>.ndjson` (reuses the trace writer's NDJSON shape);
  2. a **fresh context** begins — same chat id, same model/provider, an empty message window;
  3. the `prompt` from the tool call is inserted as a real user message and a new turn starts.
  The next turn therefore begins with a small context and continues the work, exactly like the
  user sending that prompt by hand. The chat is *not* deleted, so history stays readable and the
  trace/archive holds what was dropped.
- **`mode: "interval"` is explicitly unsupported in the first version** and returns
  `EUNSUPPORTED` with a message telling the model to chain handoffs instead (schedule the next
  `chat_restart` from the fresh turn). This is the reversible choice: a true periodic loop
  requires a scheduler with explicit lifecycle and authorization; its module location is
  not decided by the existing app-tool dispatcher. See §7.
- **Idle-only (`untilIdle: true` default).** Never fires mid-turn; defers by 30 s and re-checks,
  up to `maxDeferrals` (default 20, ~10 min) before failing with `EBUSY`.
- **One pending restart per chat.** A second call replaces the pending one and the result says so
  (`replaced: <previous dueAt>`).
- **Every restart is announced.** A `chat_restart_scheduled` / `chat_restart_fired` /
  `chat_restart_cancelled` event rides the existing `GET /events` stream; the chat transcript gets
  a system row with the due time and the prompt, and the chat header shows a small "restart in
  5 min" chip with a cancel affordance.
- **No restart is scheduled from a subagent run.** A nested call is refused with `ENOTCHAT`: a
  delegated run must not reschedule its parent's context.

### 3.4 `chat_restart_stop`

```json
{ "name": "chat_restart_stop", "arguments": { "chatId": "optional; defaults to the calling chat" } }
```

Cancels the pending schedule: `{ ok: true, cancelled: true, dueAt }` or
`{ ok: true, cancelled: false }` when there was nothing pending.

## 4. Where the two families plug in

| Surface | Change |
|---|---|
| `src/tools/wait.js`, `src/tools/chatRestart.js` | new tool modules (`SPEC` + runner), same shape as `src/tools/ask.js` |
| `src/tools/waits.js` | the wait registry: `registerWait`, `settleWait`, `listWaits`, one `.unref()`ed ticker |
| `src/tools/chatRestarts.js` | the schedule store: one pending entry per `(projectDir, chatId)`, due-time check on the same ticker |
| `src/ai-stream.js` | dispatch branches for the four names; the turn deadline used by `wait_for`'s clamp |
| `src/tools/authorization.js` | `TOOL_FAMILIES.wait = ['wait_for','wait_check']`, `TOOL_FAMILIES.chat_restart = ['chat_restart','chat_restart_stop']`; both families take the ordinary Off / Ask / Allow segment |
| `src/prompts.js` | `PRESET_TOOL_NAMES` gains the four names |
| `frontend/src/toolGroups.js` (+ `node scripts/build-tool-groups.js`) | a **Waits** row and a **Chat restarts** row |
| `scripts/test-tool-groups.mjs`, `docs/features/tool-groups.md` | the count moves 31 → 35 if E lands alone, or 36 → 40 after A and the table gains two rows (the tool-column count is pinned by test **and** prose) |
| `src/live-chat.js`, `frontend/src/components/chat/*` | the three new SSE events, the pending-restart chip, the restart system row |
| `docs/features/*`, `docs/README.md`, `CHANGELOG.md` | per feature |

## 5. Commit series

1. `feat(wait): add wait_for and wait_check with one ticker` — both leaves, the registry, the
   turn-budget clamp, the shared result shape, and the Shell-style live tail for the waited
   target. Docs: `docs/features/wait-tools.md`, `docs/agent/features/wait-tools.md`, the
   `docs/README.md` line, group rows, count bump.
2. `feat(chat): schedule a fresh-context restart of a chat` — `chat_restart` + `chat_restart_stop`,
   the idle-only scheduler, the archive file, the three SSE events, the pending chip and system
   row, the `ENOTCHAT` guard for nested runs. Docs: `docs/features/chat-restart-scheduling.md`,
   agent notes, `docs/README.md`.
3. `docs: record the wait and chat-restart decisions` — a new `docs/decisions.md` section
   (next available section at landing) pinning: turn-bounded waits, no `interval` mode yet, handoff archives are opt-in and
   never middle-of-turn, one pending restart per chat.

These are dependent implementation steps, not independently revertible commits. If the
scheduler shares the wait ticker, revert dependents first or introduce shared infrastructure
separately. Do not promise an automatic fallback interval that has not been implemented.
Ship each feature's code, tests, docs, and decisions together.

## 6. Tests

- `scripts/test-wait-for.js` — each `until` target against a fixture: shell exit, log growth,
  `contains`, file create, file change, duration, subagent terminal state, chat idle; the
  240000/turn-budget clamp; `EBADINPUT` / `ENOTARGET` / `ETOOL_DISABLED`; a timed-out wait is
  `ok: true`; the ticker is unref'd (process exits when only a wait is pending).
- `scripts/test-wait-check.js` — the three lists, the `tail` bound, counts, empty state.
- `scripts/test-chat-restart-schedule.js` — deferred while busy then fired when idle;
  `maxDeferrals` → `EBUSY`; replace-on-second-call; cancel; `EUNSUPPORTED` for `interval`;
  `ENOTCHAT` inside a subagent; the archive file's NDJSON shape; the fresh turn's context is
  empty and its first message is `prompt`.
- `scripts/test-chat-restart-tools-http.js` — the composer-direct `@chat_restart` path
  (like `@restart_app`), the SSE events, and the chat-scoped cancel.
- `scripts/test-tool-groups.mjs` — green at 40 tools after A + E (35 if E lands alone), with the two new rows.
- Mobile pass at 360 px on the restart chip and system row, 44 px cancel target.
- Cross-project denial, path traversal/symlink escape, hidden-content redaction, retained
  terminal job state, self-wait rejection, run-ID races, cancellation cleanup, schedule
  recovery/loss policy, authenticated cancel, and fresh-context boundary across providers.
- Proposed script names above are new tests to implement, not existing passing suites.
- `node scripts/test-docs-links.js` after the doc pages land.

## 7. Deliberately out of scope (with the reason)

- **`interval` / periodic scheduling.** A recurring restart is a background job with a lifecycle
  (survive app restarts, one job per project, its own list UI, a stop surface, cost reporting).
  Doing it as a tool-only interval would create a hidden loop with no surface to watch — exactly
  the failure mode the guardrails in §2 exist to prevent. The chained-handoff model gives the
  same benefit with a visible single schedule. A follow-up `feat: schedule recurring chat
  handoffs` would add `{ intervalMs, maxRuns, until }` plus a **Chat schedules** page in Settings.
- **Simulating a user answer to `ask_user`.** A restart fires on an idle chat; faking a user
  message is indefensible while the real user may be waiting on that same card.
- **Firing during an open approval prompt.** Covered by §2's idle rule.

## 8. Open questions for the product owner

1. Does a handoff keep the same chat or start a new one? (Spec: **same chat**, fresh context, so
   the user keeps one readable thread. A new chat per run is the alternative.)
2. Is the archive mandatory (always written) or opt-in per chat like the trace toggle?
   (Spec: **opt-in**, reusing the chat's trace preference, so nothing unexpected lands in the
   project.)
3. Should the restart prompt be model-authored every time, or may the user pin a standing prompt
   on the chat ("keep going until the plan is done")? (Spec: model-authored now; a pinned prompt
   is the natural follow-up.)
