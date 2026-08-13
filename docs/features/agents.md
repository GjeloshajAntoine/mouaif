# Agents

## Overview

An **agent** is a named persona stored in the project's `.mouaif.json` and used **exclusively as a delegation target for the `subagent` tool**. When the model calls `subagent({ task, agent: "reviewer" })`, the nested model call runs with that agent's instructions as its system message and, optionally, a restricted tool allowlist. Agents let the main model hand focused work to a specialist (a reviewer, a test-writer, a docs-reader) without that persona leaking into the main chat.

Agents are **not** chat personas — a chat-level persona is what [custom prompts](./custom-prompts.md) are for. Nothing in the chat stream, the chat record, or the project record references an agent; the only consumer is the `subagent` tool.

## What you can set for an agent

| Setting | Type | Default | Meaning |
|---|---|---|---|
| **Name** | string | — (required) | Unique per project, matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Mutable after creation — renaming auto-saves and redirects the edit view to the new URL. This is the value the `subagent` `agent` argument is matched against. |
| **Instructions** | string | — (required) | The persona text. Becomes the nested call's system message. Capped at 64 KiB. |
| **Tools** | tool-name list | all | Optional allowlist restricting which tools the nested call may use. Empty/unset = the nested call inherits the parent's full tool surface. |
| **Model** | model id | inherit | Optional project model (from Settings → Project models) the nested call runs on. Empty/unset = the nested call uses the chat's model and provider. An id that no longer exists fails loudly with `EUNKNOWN_MODEL` — never a silent fallback. |

Provider and prompt size are **never** configurable on an agent — the model pin carries its own provider; everything else follows the chat.

## Usage

### Manage agents

Open **Settings → Project → Agents** (in the *Project add-ons* group, alongside MCP servers and Custom prompts). The list view (`#/settings/agents`) shows one row per agent with its tool count and model pin; tapping a row opens the edit view (`#/settings/agents/<name>`). All edits on the edit view auto-save.

- **+ Add agent** opens `#/settings/agents/new`, asks for a name and instructions, creates the agent, and redirects to its edit view.
- **Name** is editable inline with auto-save and validation; renaming redirects the edit view to the new URL.
- **Instructions** is a multiline field; it saves on a short debounce.
- **Model** is a dropdown of the project's user-defined models plus "Inherit chat model". The control is the same trigger + modal the chat top bar uses (search, provider filter chips, grouped sections); the list row shows the pinned model id in its meta line.
- **Tools** is a grouped tree of native tools and configured MCP servers. Each MCP group shows its status and discovered tool names/descriptions (using cached discovery data while stopped). Selecting an MCP server stores its server slug, so current and future tools from that server are available to the agent. All groups checked = inherit everything; unchecking builds an explicit allowlist.
- **Delete** removes the agent. Nothing references agents, so no cleanup is needed.

### REST

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/agents?projectDir=<abs>` | — | `{ agents: [...] }` |
| `POST` | `/api/agents` | `{ projectDir, name, content, tools?, modelId? }` | `{ agent }` (201); 400 on invalid/duplicate name |
| `GET` | `/api/agents/:name?projectDir=<abs>` | — | `{ agent }` or 404 |
| `PATCH` | `/api/agents/:name` | `{ projectDir, name?, content?, tools?, modelId? }` | `{ agent }`; `name` is now mutable (renames the agent); `modelId: ""` clears the pin |
| `DELETE` | `/api/agents/:name?projectDir=<abs>` | — | `{ ok, removed }` |

### Delegate with `subagent`

The native `subagent` tool accepts an optional `agent` argument matched against the stored names:

```json
{ "task": "Review the staged changes for regressions.", "agent": "reviewer" }
```

The `agent` parameter's description is built per request and enumerates the current agent names, so the model sees exactly what it can call.

### Invoke an agent yourself with `@`

You don't have to wait for the model to delegate. In the chat composer, type `@` and pick the agent from the **Agents** section (or type `@<name>`), write the task, and send:

```
@reviewer Check the staged changes for regressions.
```

A leading `@<agent> <task>` dispatches the agent directly through `POST /api/tools/subagent` — the same dispatcher and authorization gate the model-driven path uses. The run shows as a `subagent` tool card pair and the agent's answer lands in the transcript as an assistant message. A leading `@<agent>` with no task (or `@` mid-text) sends to the model as plain text. See [at-mention](./at-mention.md).

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/api/tools/subagent` | `{ projectDir, chatId, task, agent?, context?, modelId?, providerId? }` | `{ ok, id, name, args, result, toolCall }`; 400 on missing task; 403 when the subagent tool is off/denied |

When a name is provided:

- The nested call's system message is the agent's **instructions** (replacing the generic "focused subagent" persona).
- If the agent has a **tools** allowlist, the nested call is restricted to it.
- If the agent has a **model** pin, the nested call runs on that project model (its own provider connection) instead of the chat's model.
- Everything else is inherited from the parent: MCP surface and the authorization gate.

An **unknown name returns a typed error** — no silent fallback to a generic subagent:

```json
{ "ok": false, "error": { "code": "EUNKNOWN_AGENT", "message": "Unknown agent \"reviewr\"", "available": ["reviewer"] } }
```

## Implementation notes

The mobile agent editor sheet reserves the top safe area at its fixed overlay so it cannot extend beneath the device status bar.

- Storage: `.mouaif.json` under `agents` as `{ name, content, tools?, modelId?, createdAt, updatedAt }`. The legacy `agentPresets` key is read as a one-release fallback (its `id` becomes `name`; extra fields like `title`/`promptSize`/`agentFiles` are dropped, `modelId` is kept) and removed on first write.
- The model pin resolves at dispatch time: `agents.resolveModel()` finds the project model by id, and the subagent dispatch hydrates it with the app-level provider connection (same sanitization as chat model resolution — credentials never come from the project file).
- Direct invocation (`POST /api/tools/subagent`) reuses the model loop's single-call runner `ai.runSingleToolCall()` — circuit breaker, authorization gate, and dispatcher are shared, so behavior matches a model-initiated call exactly. The chat's current model is the default when the agent has no pin and no explicit `modelId` is passed.
- The 64 KiB cap is applied on write; oversized content is truncated with a trailing `[... truncated ...]` note.
- The feature summary reports `[agents] N available`; the `list_features` tool and `GET /api/features` report `agents: { discovered: [{ name }] }`.
- Source: `src/agents.js`, `src/index.js` (`handleAgents`), `src/ai.js` (subagent dispatch + spec builder), `src/tools/subagent.js`, `frontend/src/components/SettingsAgents.jsx` (list + edit views, routed at `#/settings/agents[/<name>]`), `frontend/src/components/SettingsProject.jsx` (agent list rows + inline create; rows link to the standalone editor). The agent model pin uses the shared `frontend/src/components/ModelPickerField.jsx`.

## Related

- [Custom prompts](./custom-prompts.md) — the chat-level persona mechanism.
- [Agent feature prompt and tool](./agent-feature-prompt.md) — how agents surface in `list_features`.
- [Tool authorization](./tool-authorization.md) — the gate the nested call still passes through.
