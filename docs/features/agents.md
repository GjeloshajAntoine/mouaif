# Agents

## Overview

An **agent** is a named persona stored in the project's `.mouaif.json` and used **exclusively as a delegation target for the `subagent` tool**. When the model calls `subagent({ task, agent: "reviewer" })`, the nested model call runs with that agent's instructions as its system message and, optionally, a restricted tool allowlist. Agents let the main model hand focused work to a specialist (a reviewer, a test-writer, a docs-reader) without that persona leaking into the main chat.

Agents are **not** chat personas — a chat-level persona is what [custom prompts](./custom-prompts.md) are for. Nothing in the chat stream, the chat record, or the project record references an agent; the only consumer is the `subagent` tool.

## What you can set for an agent

| Setting | Type | Default | Meaning |
|---|---|---|---|
| **Name** | string | — (required) | Unique per project, matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Immutable after creation. This is the value the `subagent` `agent` argument is matched against. |
| **Instructions** | string | — (required) | The persona text. Becomes the nested call's system message. Capped at 64 KiB. |
| **Tools** | tool-name list | all | Optional allowlist restricting which tools the nested call may use. Empty/unset = the nested call inherits the parent's full tool surface. |

Model, provider, and prompt size are **never** configurable on an agent — the nested call always uses the chat's model and provider.

## Usage

### Manage agents

Open **Settings → Project → Agents**. The section lists agent names with a tool-count badge; tap a row to expand its editor. All edits auto-save.

- **New agent** prompts for a name, creates the agent, and opens its editor.
- **Name** is shown read-only in the editor (immutable after creation).
- **Instructions** is a multiline field; it saves on a short debounce.
- **Tools** is a checklist of the native tools plus one entry per configured MCP server. All checked = inherit everything; unchecking builds an explicit allowlist.
- **Delete** removes the agent. Nothing references agents, so no cleanup is needed.

### REST

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/agents?projectDir=<abs>` | — | `{ agents: [...] }` |
| `POST` | `/api/agents` | `{ projectDir, name, content, tools? }` | `{ agent }` (201); 400 on invalid/duplicate name |
| `GET` | `/api/agents/:name?projectDir=<abs>` | — | `{ agent }` or 404 |
| `PATCH` | `/api/agents/:name` | `{ projectDir, content?, tools? }` | `{ agent }`; `name` is immutable |
| `DELETE` | `/api/agents/:name?projectDir=<abs>` | — | `{ ok, removed }` |

### Delegate with `subagent`

The native `subagent` tool accepts an optional `agent` argument matched against the stored names:

```json
{ "task": "Review the staged changes for regressions.", "agent": "reviewer" }
```

The `agent` parameter's description is built per request and enumerates the current agent names, so the model sees exactly what it can call.

When a name is provided:

- The nested call's system message is the agent's **instructions** (replacing the generic "focused subagent" persona).
- If the agent has a **tools** allowlist, the nested call is restricted to it.
- Everything else is inherited from the parent: model, provider, MCP surface, and the authorization gate.

An **unknown name returns a typed error** — no silent fallback to a generic subagent:

```json
{ "ok": false, "error": { "code": "EUNKNOWN_AGENT", "message": "Unknown agent \"reviewr\"", "available": ["reviewer"] } }
```

## Implementation notes

- Storage: `.mouaif.json` under `agents` as `{ name, content, tools?, createdAt, updatedAt }`. The legacy `agentPresets` key is read as a one-release fallback (its `id` becomes `name`; extra fields like `title`/`modelId`/`promptSize`/`agentFiles` are dropped) and removed on first write.
- The 64 KiB cap is applied on write; oversized content is truncated with a trailing `[... truncated ...]` note.
- The feature summary reports `[agents] N available`; the `list_features` tool and `GET /api/features` report `agents: { discovered: [{ name }] }`.
- Source: `src/agents.js`, `src/index.js` (`handleAgents`), `src/ai.js` (subagent dispatch + spec builder), `src/tools/subagent.js`, `src/web/src/components/SettingsProject.jsx`.

## Related

- [Custom prompts](./custom-prompts.md) — the chat-level persona mechanism.
- [Agent feature prompt and tool](./agent-feature-prompt.md) — how agents surface in `list_features`.
- [Tool authorization](./tool-authorization.md) — the gate the nested call still passes through.
