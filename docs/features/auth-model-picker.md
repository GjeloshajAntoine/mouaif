# Per-run model choice on the subagent authorization card

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

When a `subagent` tool call needs approval (the tool authorization gate is in `ask` mode), the **Authorization required** card now carries a model picker. Before tapping **Allow once** / **Allow for session** / **Always allow**, the user can choose which model executes *this* delegated run. The choice is a one-off: nothing is persisted on the chat, the agent, or the project — the next subagent call uses the chat's model again (or the agent's pinned model).

## Usage

The picker appears only on `subagent` approval cards. It lists the same union the main chat [model picker](./model-picker.md) shows:

- project-defined models (`settings.models`)
- the per-provider live catalog (`GET /api/ai/models/live`)

deduplicated by `(provider, modelId)`, sorted by provider then id. The first row is a **"(chat default)"** entry that keeps the run on the chat's current model (or the agent's model pin, when the called agent has one). The trigger shows `(chat default) <modelId>` until the user picks an override. Below it, a **thinking** dropdown offers the picked model's presets plus an "Inherit chat thinking" first row (the same `ThinkingSelectField` the Agents editor uses).

Pick a model (and optionally a thinking level), then choose any non-deny action. The decision payload carries

```json
{
  "modelOverride": { "providerId": "openrouter", "modelId": "anthropic/claude-sonnet-4" },
  "thinkingLevel": "medium"
}
```

and the nested call runs on that model — with that reasoning effort — for this invocation only. Deny still ignores the pick.

### Precedence

Model resolution for the delegated run, most specific first:

1. **Authorization-card pick** — the user explicitly approved this run on a model, so it wins over everything else.
2. **Agent model pin** — a named agent's `modelId` (Settings → Project → Agents) applies when no card pick was made.
3. **Chat model** — the fallback for a generic subagent with no pin.

Thinking level follows the same precedence: the card's pick wins, then the agent's `thinkingLevel`, then the chat's inherited level.

### REST

The existing decision endpoint is unchanged; `payload` is now also honored for `subagent` calls:

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/api/tools/authorization/decision` | `{ projectDir, chatId, callId, decision, payload?: { modelOverride: { providerId, modelId }, thinkingLevel?: string } }` | `{ ok: true }` |

`payload` was already a generic channel used by `ask_user`; `subagent` is the second consumer. A malformed override (missing `providerId`/`modelId`, unknown model, missing provider connection) fails the delegated call loudly with a typed `EUNKNOWN_MODEL` / `EPROVIDER_NOT_FOUND` tool error — never a silent fallback.

## Implementation notes

- **Payload channel.** `src/tools/authorization.js` `recordDecision` forwards any `payload` object through the pending decision's `resolve({ decision: 'allow', payload })`. `src/ai-stream.js` already captured that for `ask_user`; it now also captures `payload.modelOverride` and `payload.thinkingLevel` for `subagent` and passes them to the dispatcher as `callOpts.modelOverride` / `callOpts.thinkingLevel`.
- **Safe hydration.** The override record is resolved inside the subagent branch of `src/ai-stream.js`: the project model record (found by `modelId` + `providerId` in `settings.getResolved(...).models`) contributes only identity/selection metadata (`id`, `provider`, `label`, `contextWindow`, `thinking`, `pricing`); transport and credentials always come from the app-level provider connection — the same sanitization rule `resolveModel` enforces in `src/server-shared.js`. Live-catalog models that are not in the project `models` array resolve by provider id.
- **Card UI.** `buildAuthModelPicker(state, request)` in [frontend/src/components/chat/cards.js](../../frontend/src/components/chat/cards.js) builds the control from `state.models` + `state.liveByProvider` and renders [frontend/src/components/AuthModelPicker.jsx](../../frontend/src/components/AuthModelPicker.jsx) into a host element. That adapter owns this imperative card's model + thinking selection and passes them to the props-driven `ModelPickerField` and `ThinkingSelectField`; the current selection is exposed via `host._selected()` (returning `{ modelOverride, thinkingLevel }`) so the decision payload reads it. `authorizationCard` gained a trailing `state` argument; all call sites in [frontend/src/components/chat/stream.js](../../frontend/src/components/chat/stream.js) — the direct `/shell` path, the pending-reload path, and both SSE paths (top-level and nested subagent) — pass it through.
- Styling lives in [frontend/src/chat-view.css](../../frontend/src/chat-view.css) under `.mp*` (the shared field) and [frontend/src/tool-cards.css](../../frontend/src/tool-cards.css) under `.tool-card__auth-model-*` (the card slot, full-width, ≥ 44 px tap target). The card renders `variant="sheet"`, so at phone widths it opens the same fixed visual-viewport modal as the chat top bar rather than an anchored popover clipped by the transcript.

## Related

- [Tool authorization](./tool-authorization.md) — the gate the card belongs to.
- [Agents](./agents.md) — named subagent personas and their model pins.
- [Model picker](./model-picker.md) — the main picker whose data feeds this one.