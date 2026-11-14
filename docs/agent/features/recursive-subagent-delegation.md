# Recursive delegation internals

## Overview

This user-approved correction extends committed cooperative groups `d9786e18` in the existing isolated follow-up worktree. The old blanket nested `EPARENT_ONLY`/no-recursion contract is superseded by rooted local-parent controls and finite budgets (default `maxDepth` 3, so nested subagents can delegate without configuration).

## Usage

See [public contract](../../features/recursive-subagent-delegation.md). Optionally configure the turn-wide `subagentLimits` (app or project settings, no UI) before a root turn (default depth 3; `maxDepth: 1` disables recursion), then use the existing tools; no tool names, REST endpoints or default port change.

```bash
npm run test:subagent-recursion
npm run test:content
npm run test:subagent-groups
npm run test:subagent-prompt
```

## Implementation notes

- Limits as a setting: `LIMIT_RANGES` and `DEFAULT_LIMITS` in `src/tools/subagent-orchestration.js` are the one definition of the ranges and defaults. The registry (`src/content/registry.js`) declares `subagentLimits.maxDepth` / `.maxRuns` from them as `integer` fields (app and project scope, `clientVisible`, so app writes pass the policy), and `checkField` in `src/content/service.js` refuses a non-integer or out-of-range value on every `applyPatch` write. Declaring defaults puts `subagentLimits` in `settings.DEFAULTS` and in the client and reset key lists.
- Reads are tolerant, writes are strict: `streamChat` builds the root `Scope` from `rootSubagentLimits(projectDir)` (`src/ai-stream.js`), which runs the resolved value through `resolveLimits()`. An invalid field falls back to `DEFAULT_LIMITS` and is logged once per project and distinct bad value (`console.warn`, deduplicated in a process-local set). The `Scope` constructor still throws `EBADINPUT` on a bad limit; it now only sees sanitized values from `streamChat`. The fallback is the built-in default, not the app value, because `getResolved` has already merged the project value over it.
- Tool description: `buildSpec(agentNames, { maxDepth })` in `src/tools/subagent.js` writes the root scope's `maxDepth` into the description; at 1 the sentence says subagents cannot delegate. `collectToolSpecs` passes `scope.root.limits.maxDepth`, or the settings value when it has no scope (the chat tool preview). A project tool-wording override of `subagent` replaces the whole description, as for any tool.
- `src/tools/subagent-orchestration.js`: a root registry captures validated finite limits and admitted identities; each run owns a separate local `Scope` with root/parent/depth provenance. Local direct-child handles prevent cross-sibling/cousin control, and self/ancestor handles reject `EDEADLOCK`. Group DAGs stay local; root-shared admission/group/artifact/conflict/observation budgets prevent recursive scope resets.
- Subagent model requests are not limited in number: `Scope.acquire()` only refuses a request whose run or scope already ended, and no slot is held or queued. Admission limits are not claims about simultaneous shell tools/detached jobs.
- Each parent cancellation recurses through child scopes. Root cleanup begins all descendant cleanup concurrently and finalizes any surviving rows once at the common one-second boundary; late results/events and descendant billing callbacks are guarded. Escalated conflicts retain bounded metadata until root completion, allowing ancestors to arbitrate without arbitrary descendant visibility.
- `src/ai-stream.js`: child streams receive their own local scope, inherited exact advertised tools plus a permission ceiling, selected attachment refs, and executing model. Forged unadvertised calls and cross-scope control reject before approval; current gate plus inherited Ask/off remain effective. Inherited allowlist modes conservatively force approval. Recursive agent model switches require an explicit user approval override.
- Nested streams finish their own children before returning aggregate usage/cost. `onDelegatedUsage` passes descendant deltas upward without duplicating completion counts; own-round prompt accounting remains distinct from descendants, and final remainder reconciliation adds only unreported totals. Recursive nested events and result IDs stay under ancestor transcript cards. `src/toolFeedback.js` preserves rooted receipt metadata.

## Verification and limitations

`scripts/test-subagent-limits-settings.js` (part of `test:subagent-recursion`, stubbed upstream) covers the tolerant read and its single warning, write refusal and app-scope acceptance through the settings routes and `update_settings`, and the description at depth 1 and above. `scripts/test-content-registry.js` and `scripts/test-content-service.js` cover the declarations and the field check.

Scope tests cover the default depth-3 budget, `maxDepth: 1` opt-out, invalid finite limits, identities, local control, ancestor deadlock rejection, scoped artifacts, upward arbitration, depth/total limits, unlimited model-request concurrency and subtree abort. The HTTP fixture demonstrates real two-level synchronous recursion with concurrency 1 and a child-created background member group with concurrency 2, inherited forged-tool rejection and exact descendant prompt/completion/live/final cost totals. Scope tests also verify a common bounded shutdown deadline across a hung subtree, late completion callbacks exactly once, refused requests from an ended scope and inherited Off rejection before effects. Existing group/HTTP/orchestration, workspace/serve smoke, cost and authorization regressions remain required.

Verified: recursion/group/subagent-prompt suites, workspace/serve smoke, delegated live/total cost, authorization-clear-grants, stream-abort, tool-feedback, tool catalog, prompt/snapshot, static containment/compression, touched-file syntax, web build, docs link/internal builds and published-site consistency. No new UI layout was introduced; existing generic nested cards are reused. The web build retains the existing large-chunk warning.

No automatic merge, push, consensus, rollback, dependency installation or host-server restart. Scopes/handles are volatile; workspace ownership remains advisory. Attachment ceilings apply to explicit delegation selection, not separately authorized filesystem access. Large nested transcript payloads and usage arriving after forced shutdown remain limitations; subagent model requests have no concurrency limit. Full `npm test` remains unverified after the prior Track A dictation fixture timeout.
