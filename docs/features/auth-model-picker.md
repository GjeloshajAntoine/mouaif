# Per-run model choice on the subagent authorization card

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

## Related

- [Tool authorization](./tool-authorization.md) — the gate the card belongs to.
- [Agents](./agents.md) — named subagent personas and their model pins.
- [Model picker](./model-picker.md) — the main picker whose data feeds this one.
