# Coordinated parallel development plan

> Maintainer-only working plan (never published: the docs build reads `docs/features/` and
> `docs/agent/features/` only). Written for the five tracks requested after the screen-capture
> fix landed as `87189be4 fix: attach screen captures without losing concurrent draft edits`.

## Overview

Five features are developed in parallel on five worktrees/branches, then landed in a fixed
order through a single merge queue. Each feature keeps the repo rules: **one feature = one
commit**, Conventional Commits, mobile-first UI, a `docs/features/<slug>.md` page plus a
`docs/README.md` line, and the matching `docs/agent/features/<slug>.md` implementation notes.

The constraint that shapes the whole plan is **shared surfaces**. Four files are edited by
every track that adds or renames a tool, and they conflict textually, not semantically:

| Shared surface | Why every track touches it |
|---|---|
| `src/prompts.js` | the native tool allowlist (`PRESET_TOOL_NAMES`) |
| `src/tools/authorization.js` | tool families / binary gates |
| `frontend/src/toolGroups.js` + `frontend/build/toolGroups.json` | the app-wide group model and its generated mirror |
| `scripts/test-tool-groups.mjs`, `docs/features/tool-groups.md`, `docs/features/mouaif-features.md` | the pinned tool count (**31 today**, asserted as both a number and a per-row table) and the tools table |
| `frontend/src/components/chat/cards.js` | the subagent approval card |
| `frontend/dist/**` | the committed web build |
| `docs/README.md`, `CHANGELOG.md` | one-line additions, adjacent lines |

Rules that keep those merges cheap:

1. **One writer per shared surface at a time.** Tracks edit the shared surfaces inside the commit
   that adds the name, and rebase immediately after the previous track lands.
2. **Never commit `frontend/dist/` from a feature branch.** The build artifacts are regenerated
   once per landed track by the release caretaker as a separate
   `chore: refresh frontend build artifacts` commit (precedent: `6910395d`), which removes the
   only diff that conflicts on *every* frontend commit.
3. **`frontend/build/toolGroups.json` is regenerated inside the same commit** as the
  `toolGroups.js` edit with `node scripts/build-tool-groups.js` (it exits non-zero when the
  mirror is stale, and `scripts/test-tool-groups.mjs` fails when the two disagree).
4. **Freeze the contracts before coding.** The tool schemas, setting keys, and chat fields listed
   below are agreed here and may only change by amending this file.

## Baseline

Already on `master` at plan time:

- `87189be4` — screen-capture draft-merge fix, imported-video duration retention, missing-video-track guard.
- The `subagent` tool already supports `{ task, context, agent, images }`, an agent pin
  (`modelId`/`providerId`/`thinkingLevel` in `.mouaif.json`), and a per-call model picker on the
  approval card (`callOpts.modelOverride`, `frontend/src/components/AuthModelPicker.jsx`).
- The MCP client speaks stdio / Streamable HTTP / legacy SSE and discovers tools only; it has
  **no** `resources/read` path yet (`src/mcp.js`).

## Model policy — two models (proposed, not applied)

Status: **proposal only.** `.mouaif.json` is deliberately unchanged — no project `models`, no
`defaultAgent`, no agent pin. Applying the table below is an open decision (see the last
section), and it is a config change, never a code change.

When applied, the project carries exactly two models, both verified live in their provider
catalogs:

| Model | Provider | Available |
|---|---|---|
| `deepseek/deepseek-v4.1-flash` | `openrouter` | yes |
| `mistral-large-4` | `mistral` | yes |

Allocation — the only decision a track makes:

| Slot | Model | Why |
|---|---|---|
| Chat / orchestrator driver | `deepseek/deepseek-v4.1-flash` | cheap enough to run long turns |
| Review, second opinion, EU-hosted work | `mistral-large-4` | different family, so a review is a real cross-check |
| Nested subagent pin (`defaultAgent`, every agent) | `deepseek/deepseek-v4.1-flash` | a nested call should never inherit a pricier chat model |
| Delegated chat | either; the whole point of a per-chat pin | |

Rules that keep this honest:

- **Never pin a `~`-prefixed OpenRouter alias** (158 of 458 rows). They move upstream and silently
  change which model an agent runs.
- **Use the full slug, not a short id.** A bare `deepseek-v4.1-flash` exists in the Mistral catalog
  but is a different model; Track C's provider qualification is what prevents that class of
  mistake, so Track C lands before any agent pin is created.
- **No third model without amending this table.** Adding one is a policy change, not a per-track
  choice.
- Consequence to accept knowingly: the `codex` provider (ChatGPT plan, effectively free) is
  unused, so long autonomous runs bill OpenRouter instead of the plan.

Lane 0 adds one **pending** step: if the table is approved, pin `defaultAgent` to
`deepseek/deepseek-v4.1-flash` and give the existing `Search` agent the same pin, so a bare
`subagent` call cannot fall back to a chat's model. Until then the status quo holds: every
`subagent` call inherits its chat's model.

## Lane 0 — kickoff (serial, half a day)

1. Create the five worktrees from committed `HEAD` (never from dirty state):
   `feat/subagent-orchestration`, `feat/mcp-apps`, `feat/subagent-model-choice`,
   `feat/subagent-attachments`, `feat/wait-and-chat-restart`.
2. Freeze the contracts (below) in this file.
3. Add the one test every track needs to keep green and re-run after each rebase:
   `scripts/test-tool-groups.mjs`, `npm run lint`, `npm run test:subagent-prompt`,
   `node scripts/test-docs-links.js`.

## Delegation unit — a real chat, not a nested subagent

**Revision after review.** The unit of delegation is a **chat**, driven by the existing Chats
tools; `subagent` is kept only for throwaway nested work that must not appear as a chat.

The reasons are structural:

- A delegated chat has its own transcript, its own pinned model and its own custom prompt, so the
  delegating model can hand off work and **the user can open that chat later and continue it**. A
  subagent's transcript lives inside the parent's tool card and dies with the turn.
- Context and cost stay separated: the delegated turn bills to its own `chat_store` row, and the
  parent's window never holds the delegated reasoning.
- The parts already ship: `create_chat` (title, topic, providerId, modelId), `update_chat` (adds
  `promptId` / `promptSize` — the role persona is a **custom prompt**, not an agent),
  `start_chat` (start a background turn, returns a URL), `get_chat` (recent messages),
  `search_chats`, `change_working_folder`.

Three gaps make this a feature rather than a prompt trick:

1. **No fan-out.** `src/ai-stream.js` dispatches Chats tools inline through
   `tools/mouaif.js → runAppTool`, so the parallel branch
   (`calls.length > 1 && calls.every(c => c.name === 'subagent')`) never covers `start_chat`:
   several delegations in one turn run one after another. Either teach that branch to recognise
   chat delegations or add a `delegate_chat` tool that starts N of them together.
2. **Persona plumbing.** `create_chat` accepts no `promptId`, so giving a delegated chat its role
   prompt costs a second `update_chat` call.
3. **Waiting and read-back.** A delegated turn is asynchronous, so the parent has to poll. Track
   E's `wait_for` already specifies `until: "chat:<chatId>"`, which closes the loop as
   delegate → wait → `get_chat`.

## Track A — Subagent orchestration (isolated nested work only)

**Goal.** A parent model can observe, message, and steer the subagents it started, and two
sibling subagents can hand work to each other without the parent relaying it.

> Scope narrowed by the revision above: Track A's tools serve delegations that must **not** become
> chats (one-shot reviews, throwaway probes). Chat-shaped delegation is the path above.

**Files.** `src/tools/subagent*.js`, `src/ai-stream.js` (dispatch + in-flight registry),
`src/tools/authorization.js`, `src/prompts.js`, `frontend/src/toolGroups.js`,
`frontend/src/components/chat/cards.js`, `docs/features/subagent-tools.md`,
`docs/agent/features/subagent-tools.md`.

**Frozen tool contract** (all under the existing binary `subagent` gate — no new gate):

```json
{ "name": "subagent_messages", "arguments": { "callId": "…", "since": "…", "limit": 20 } }
{ "name": "subagent_status",   "arguments": { "callId": "…" } }
{ "name": "subagent_stop",     "arguments": { "callId": "…" } }
{ "name": "subagent_publish",  "arguments": { "name": "…", "summary": "…", "files": [], "snippets": [] } }
{ "name": "subagent_read",     "arguments": { "name": "…", "includeFiles": false } }
```

**Commits.**

1. `feat(subagent): add subagent_messages to read a delegated run's progress` — an in-flight
   registry keyed by `(projectDir, chatId, callId)` in `src/ai-stream.js`; the parent polls a
   bounded, redaction-safe slice of the nested run's progress lines. Reuses the existing
   `subagent_event` fan-out rather than adding a second stream.
2. `feat(subagent): add subagent_status to inspect delegated runs` — one row per run:
   `{ callId, agent, modelId, state, startedAt, elapsedMs, lastLine }`; finished runs are kept
   until the parent turn ends.
3. `feat(subagent): add subagent_stop to cancel a delegated run` — wires the run's existing
   abort controller; the tool result reports whether the run was already finished.
4. `feat(subagent): add subagent_publish and subagent_read for sibling hand-off` — a per-chat,
   turn-scoped store `{ name, summary, files, snippets, author }`; `subagent_read` resolves a
   name with the same redaction path as File tools.
5. `feat(subagent): report a coordination summary on delegated runs` — the tool result gains
   `{ callId, modelId, published: [], nextSuggested }` so the parent can plan the next batch.
6. `docs: document subagent orchestration` — `docs/features/subagent-tools.md`, the
   `docs/README.md` line, tool-group counts, and `docs/agent/features/subagent-tools.md`.

**Tests.** New `scripts/test-subagent-orchestration.js` (registry lifecycle, bounded slices,
stop semantics, publish/read round-trip, unknown `callId` typed error `EUNKNOWN_CALL`), plus the
existing `test-tool-groups.mjs`, `test-prompt-snapshot.js`, and `test-subagent-*` scripts.

**Risks.** The natural spin risk is recursion — new tools must stay *out* of the nested run's
surface exactly like `subagent` does today; the parallel-batch branch in `ai-stream.js`
(`calls.every(c => c.name === 'subagent')`) must not start treating orchestration calls as
parallelizable.

## Track B — MCP Apps support (official MCP Apps extension)

**Goal.** A remote or stdio MCP server that declares a `ui://` resource renders a real
interactive UI inside the chat, sandboxed, with tool calls routed through the normal gate.

**Official references** (pin these in the doc, no third-party summary):

- Overview: <https://modelcontextprotocol.io/extensions/apps/overview>
- Specification: `specification/2026-01-26/apps.mdx` in
  <https://github.com/modelcontextprotocol/ext-apps> (SEP-1724 extension).
- API index + host bridge: <https://apps.extensions.modelcontextprotocol.io/api/>,
  <https://apps.extensions.modelcontextprotocol.io/api/modules/app-bridge.html>
- Reference host: `examples/basic-host` (`sandbox.html`, `AppBridge`, `buildAllowAttribute`).
- Package: `@modelcontextprotocol/ext-apps@2.0.3`
  (exports `.`, `./server`, `./app-bridge`, `./react*`, `./schema.json`).

**Facts the implementation rests on** (from the spec text):

- A tool declares its UI with `_meta.ui.resourceUri` (the flat `_meta["ui/resourceUri"]` form is
  deprecated, still accepted) and may restrict callers with
  `_meta.ui.visibility: ["model" | "app"]` (default `["model","app"]`).
- The resource is served with `mimeType: "text/html;profile=mcp-app"` and its own
  `_meta.ui` carrying `csp: { connectDomains, resourceDomains }` and
  `permissions: { camera, microphone, … }`.
- The host fetches the resource, renders it in a **sandboxed iframe**, and talks to it over
  `postMessage` with a JSON-RPC dialect: `ui/initialize`, tool input/result notifications,
  `ui/message`, `ui/openLink`, `ui/updateModelContext`, `ui/request-display-mode`
  (`inline` / `fullscreen` / `pip`), plus `tools/call`.

**Commits.**

1. `feat(mcp): read MCP Apps tool metadata and UI resources` — record `resourceUri` and
   `visibility` on discovered tools, hide `visibility: ["app"]` tools from the model's tool list
   while keeping them app-callable, add a `resources/read` path with per-(server, uri) caching
   bound to the server lifecycle, typed errors. ADR note `docs/decisions.md`: *MCP Apps render in
   a sandboxed iframe with a hand-rolled postMessage bridge; no new runtime dependency.*
2. `feat(web): add the MCP Apps postMessage bridge` — `frontend/src/components/chat/mcpAppBridge.js`
   implementing the `ui/*` methods and the shared `tools/call`, plus `allow`-attribute derivation
   from `_meta.ui.permissions` and CSP enforcement from `_meta.ui.csp` (`connectDomains`,
   `resourceDomains`); unknown methods answer a typed JSON-RPC error.
3. `feat(chat): render an MCP App in a sandboxed iframe next to its tool call` —
   `frontend/src/components/chat/McpAppFrame.jsx`, mobile-first: inline card by default, a
   44 px-tall header with the app title and a fullscreen control, fullscreen as a sheet, and the
   existing text/image tool result as the fallback when the app cannot render.
4. `feat(mcp): route app-initiated tool calls through the authorization gate` — an app's
   `tools/call` goes through the same decision path as a model call (off/ask/allow), scoped to
   its own server, with the app named on the approval card.
5. `fix(web): keep the web CSP compatible with sandboxed app frames` — only if `srcdoc`
   frames/dynamic app servers need it; `scripts/test-web-csp.js` is the guard.
6. `docs: document MCP Apps` — `docs/features/mcp-apps.md`, a cross-link from
   `docs/features/mcp.md`, the `docs/README.md` line, `docs/agent/features/mcp-apps.md`, and the
   CLI/REST surface note if `GET /api/mcp/tools` gains fields.

**Tests.** `scripts/test-mcp-apps-detection.js` (fixture server emitting `_meta.ui`),
`scripts/test-mcp-apps-bridge.mjs` (method table, display modes, unknown method, CSP/allow
derivation), `scripts/test-mcp-apps-ui.mjs` (inline → fullscreen, fallback path, touch targets),
plus the existing `test-mcp-*` and `test-web-csp.js`.

**Risks.** This is the largest and least reversible track: a sandboxed iframe inside a
mobile-first transcript is a new rendering surface (virtual list height measurement, PWA offline
shell, `sw.js` caching of app HTML). Keep it last in the landing order, and gate the whole track
behind a project setting so an unrenderable app degrades to today's tool result.

## Track C — Subagent model choice in the UI

**Goal.** Choosing the model a delegation runs on is a first-class, discoverable option rather
than a hidden picker on an approval card.

**Precedence (frozen).**
`approval-card pick` → `agent pin` → `chat subagent model` → `project subagent model` →
`chat's own model`.

**Files.** `src/agents.js`, `src/chats.js`, `src/settings.js`, `src/ai-stream.js`,
`frontend/src/components/SettingsAgents.jsx`, `frontend/src/components/AuthModelPicker.jsx`,
`frontend/src/components/settings/*`, `frontend/src/components/chat/cards.js`,
`docs/features/agents.md`, `docs/agent/features/agents.md`.

**Commits.**

1. `feat(agents): offer every provider's catalog in the agent model picker` — the editor already
   unions chat and image catalogs across providers; add search, a "Same as the chat" row, and an
   explicit provider qualification so a pin can never resolve ambiguously.
2. `feat(agents): show the effective model on the Agents list and the approval card` — one line
   per row (`runs on: …` / `follows the chat`), and the approval card states
   `runs on X instead of Y` before the user approves.
3. `feat(chat): add a per-chat default model for delegated runs` — chat field
   `subagentProviderId` / `subagentModelId` in `src/chats.js` + `update_chat`, edited from the
   chat sheet; the project-level default reuses project settings.
4. `feat: resolve the subagent model precedence in one helper` — `src/agents.js`
   `resolveSubagentModel({agent, chat, project, override})`, unit-tested as a precedence table;
   `ai-stream.js` calls it instead of the current inline chain.
5. `docs: document subagent model choice` — `docs/features/agents.md` update,
   `docs/agent/features/agents.md` update, `docs/README.md` if the page is new.

**Deliberately rejected.** A `model` *argument* on the `subagent` tool. Model ids are
project/provider-specific, the catalog is live, and a free-form slug invites
`EUNKNOWN_MODEL` retries; pins belong on agents and on the chat, and the approval card already
covers the one-off case. Revisit only if `search_models` output is ever fed into the tool schema
as a bounded enum.

**Tests.** `scripts/test-agents-model-precedence.js` (the table),
`scripts/test-agents-model-pin-http.js`, `scripts/test-agents-model-pin-ui.mjs`,
`scripts/test-auth-model-picker.js`, plus `test-agents.js` / `test-agents-http.js`.

## Track D — File and definition attachments before a delegated run

**Goal.** The user (or the parent model) attaches files and project definitions to a delegation
*before* it starts, so the subagent reads exactly what it should instead of rediscovering it.

**Frozen contract.**

```json
{
  "task": "…",
  "files": ["src/ai-stream.js", "docs/decisions.md"],
  "definitions": ["AGENTS.md", "claude:review-checklist"],
  "attachmentsBudgetBytes": 262144
}
```

- `files`: project-relative paths, max 8, resolved through the same read path as File tools so
  **hide-file-content redaction applies** and nothing outside the project is reachable.
- `definitions`: named instruction sources — the agent files discovered by
  `src/agentFiles.js` plus named snippets stored on the project (`definitions` array in
  `.mouaif.json`, reusable by agents and by the approval card).
- Oversized input fails with a typed `EBIGINPUT` naming the offending path; the total default cap
  is 256 KiB, overridable per project.

**Files.** `src/tools/subagent.js`, `src/ai-stream.js`, `src/agents.js`, `src/settings.js`,
`src/files.js`, `frontend/src/components/chat/cards.js`,
`frontend/src/components/AgentFilePicker.jsx`, `docs/features/subagent-attachments.md`,
`docs/agent/features/subagent-attachments.md`.

**Commits.**

1. `feat(subagent): accept file attachments on a delegated run` — `files` argument, resolved and
   rendered as fenced blocks with a path header, deduped, capped, redaction-aware.
2. `feat(subagent): accept named definitions on a delegated run` — `definitions` argument,
   resolved from agent files plus project definitions, deduped against `files`.
3. `feat(chat): attach files to a delegation from the approval card` — the card gains an
   attachment row (chips, remove, count cap) that reuses the existing mobile file picker and
   rides the authorization payload like `modelOverride` does today.
4. `feat(agents): declare default attachments on an agent` — `files` and `definitions` on the
   agent record, applied to every delegation that does not override them.
5. `feat(subagent): report attachments in the tool result` — `{ attached: [{ path, bytes }],
   budgetBytes, truncated: [] }` so the parent can see what the subagent actually read.
6. `docs: document subagent attachments` — the new page, the `docs/README.md` line, a cross-link
   from `docs/features/subagent-image-generation.md` (images vs files), and the agent notes.

**Tests.** `scripts/test-subagent-attachments.js` (path containment, cap, dedupe, redaction of a
hidden range, `EBIGINPUT`), `scripts/test-subagent-attachment-card.mjs` (chips, cap, payload
shape), plus `test-file-preview-safety.js` and `test-hidden-content-*`.

**Risks.** Two payload channels for the same intent (tool argument vs approval-card attachment):
the card's payload must win the same way `modelOverride` does, and the tool result must show the
merged set once.

## Track E — Waiting tools and scheduled chat restarts

**Goal.** A long autonomous run can *wait productively* instead of polling, and can hand itself a
fresh context on a schedule that the user can see and cancel.

**Full build spec:** [`../specs/chat-restart-tools.md`](../specs/chat-restart-tools.md) — frozen
tool contracts, guardrails, commit series, tests, and the deliberately excluded `interval` mode.
The summary here is the coordination view only.

**New tool names (first track to touch the pinned surface).** `wait_for`, `wait_check` (the
**Waits** family) and `chat_restart`, `chat_restart_stop` (the **Chat restarts** family). Two new
families in `src/tools/authorization.js`, two new rows in `frontend/src/toolGroups.js` + its
generated mirror, four names in `PRESET_TOOL_NAMES`, and the tool count moving **31 → 35** in
`scripts/test-tool-groups.mjs`, `docs/features/tool-groups.md`, and `docs/features/mouaif-features.md`.

**Guardrails (frozen, they are the whole design).**

- `wait_for` is bounded by `min(timeoutMs ≤ 240000, time left in the turn)` and returns
  `timedOut` — never an error, never a zombie turn. One `.unref()`ed ticker serves every wait, so
  no per-call timer and no unbounded buffer accumulates.
- `chat_restart` fires **only when the chat is idle**, defers while a turn is open, and gives up
  with `EBUSY` after ~10 min of deferrals rather than interrupting a live turn.
- **One pending restart per chat**, always announced: a `chat_restart_scheduled` /
  `chat_restart_fired` / `chat_restart_cancelled` event, a system row in the transcript, and a
  cancellable chip in the chat header.
- **No `interval` mode.** A recurring restart belongs in `src/tools/mouaif.js` as a real scheduled
  job with its own Settings page; a tool-only interval would be a hidden loop. The model chains
  handoffs instead — same benefit, one visible schedule.
- A nested (subagent) call is refused with `ENOTCHAT`: a delegated run must not reschedule its
  parent's context.

**Commits.** (1) `feat(wait): add wait_for and wait_check with one ticker`; (2)
`feat(chat): schedule a fresh-context restart of a chat`; (3) `docs: record the wait and
chat-restart decisions`. Each is revertible alone.

**Depends on Track A** for the `subagent:<callId>` wait target (A's in-flight registry) and
**on nothing else**; `shell:` and `log:` targets read today's `groupCli.js` background children
and `.mouaif/logs/` files. Land E **after A** so the registry exists.

**Tests.** `scripts/test-wait-for.js`, `scripts/test-wait-check.js`,
`scripts/test-chat-restart-schedule.js`, `scripts/test-chat-restart-tools-http.js`, plus
`scripts/test-tool-groups.mjs` at 35 tools and a 360 px pass on the restart chip.

## Landing order and merge queue

Tracks develop in parallel; they land **serially**, each rebasing on the new `master` and
re-running the shared-surface suites before the next one starts. The order puts the
newest-tool-name track first (it settles the tool-group counts), then the tracks that only touch
the same two UI files:

1. **A** — subagent orchestration (new tool names: `toolGroups.js`, `prompts.js`, counts, docs table).
2. **E** — waits and chat restarts (four new tool names **on top of A's**, two new families, the
  31 → 35 count bump; rebase immediately after A, before any other tool-name track).
3. **C** — subagent model choice (no new tool names; `cards.js` + `agents.js`).
4. **D** — subagent attachments (no new tool names, one new argument; `cards.js` second writer).
5. **B** — MCP Apps (largest, new render surface; `cards.js` third writer, `mcp.js`, new components).

Only **A** and **E** add tool names, so they land back to back; every other track is a consumer
of the frozen count and just re-runs `scripts/test-tool-groups.mjs`. If E is deferred, C, D and B
can land without renumbering anything.

After each landing: `chore: refresh frontend build artifacts` (single caretaker commit), the
track's targeted suites (`npm run test:subagent-prompt` for A/C/D; for B the `scripts/test-mcp-*.js`
set, which has no npm alias today), and a `docs:build` + `docs:publish:check` pass.

## Per-track definition of done

- Conventional-Commit series, one feature per commit, each revertible on its own.
- `node -c` (or `node --check` for ESM) on every touched file; the targeted `npm run test:*`
  scripts for that track green; `npm run test:tool-groups` green whenever a tool name changed.
- A `docs/features/<slug>.md` page (H1, Overview / Usage, no decision numbers, no
  "Implementation notes" section), its `docs/README.md` line, and the `docs/agent/features/`
  counterpart holding paths and wire shapes.
- `CHANGELOG.md` entry in the feature commit.
- UI work reviewed at 360 px width first, 44 px touch targets, no hover-only affordance.
- A short written note in the track's agent notes: what shipped, what was verified, what is open.

## Open product questions (answer before the affected commit, not at the end)

- Delegation: does a delegated chat start **empty** or with the delegating chat's recent context
  summarized into its `topic`? (Default: a summary line plus the task, not a transcript copy.)
- Delegation: fan-out — extend the parallel branch for `start_chat`, or add `delegate_chat`?
- Config: is the two-model policy applied, or does it stay documented advice? (Leaning: apply,
  since it is one `.mouaif.json` edit and reversible.)
- Track B: should MCP App frames be *opt-in per project* (default off) or on whenever a server
  declares a `ui://` resource? Default-off is the reversible choice.
- Track B: does the app get its own authorization identity on the approval card, or is it
  attributed to the server that served it?
- Track D: are project `definitions` a free-form snippet store, or strictly the existing agent
  files plus named agents?
- Track A: should `subagent_publish`/`subagent_read` survive the parent turn (a real scratchpad)
  or die with it (a coordination bus only)?
- Track E: does a restart handoff keep the same chat (spec default) or open a new one per run?
- Track E: is the dropped-context archive always written, or opt-in per chat like the trace
  toggle (spec default)?
- Track E: may the user pin a standing restart prompt on the chat, or is every prompt
  model-authored?
