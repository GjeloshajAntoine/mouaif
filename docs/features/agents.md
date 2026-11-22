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
| **Model** | provider + model id | inherit | Optional model from the same project + live-catalog union as the chat top bar. Empty/unset = the chat's model and provider (unless a chat or project subagent default is set; see below). Provider-qualified live models do not need to be duplicated in project settings; legacy unqualified ids that no longer exist fail with `EUNKNOWN_MODEL`. |
| **Thinking** | thinking level | inherit | Optional reasoning-effort override for the nested call (same values as the chat's thinking dropdown). Empty/unset = the nested call follows the chat's thinking level. |

Provider and prompt size are **never** configurable on an agent — the model pin carries its own provider; everything else follows the chat. Thinking level **is** configurable (an optional reasoning-effort override that only applies when the agent's nested call runs).

## Usage

### Manage agents

Open **Settings → Project → Agents**. The project settings list shows each agent as a compact, single-line name; tapping one opens its editor. **Back** and successful deletion return directly to project settings, preserving the originating chat or project list. The dedicated list (`#/settings/agents`) remains available: editors opened there return to that list instead.

- **+ Add agent** uses the same page from either entry point. Set the name, instructions, model, thinking, and tools before tapping **Create**. Nothing is saved until creation succeeds; errors leave the form intact. Creation replaces the add page in browser history with the editor.
- **Name** is editable inline with auto-save and validation; renaming updates the URL without remounting the form, losing focus, or adding history entries. An agent named `new` is supported.
- **Instructions** is a multiline field; it saves on a short debounce. Rapid edits across fields are merged and saves run in order, including changes made during a rename. **Back** waits for pending saves; a failed save keeps the editor open with **Retry save**.
- **Model** and **Thinking** sit on one line with the same compact controls as the chat bar: the model picker (provider chips, grouped rows, search, app-wide Pinned and Recent sections, pin stars, refresh) and the thinking select. The model list is the same project + live-catalog union as the chat top bar. "Same as the chat model" clears both the saved model and provider. The union reads every provider's live chat catalog (`/api/ai/models/live`) plus its live **image** catalog (`/api/ai/models/live?purpose=image`) — an image-only model such as an OpenRouter `/images/models` row or a Gemini Imagen model is never in the chat slice — plus the models already pinned in the project. A provider with no separate image slice returns its chat list, so asking every provider and de-duping on provider + id is safe.
- **Tools** is a grouped tree of native tools and configured MCP servers. Every row (group and child leaf alike) carries the tool's one-line description, exactly as it reads in the chat tools card and in Settings → Project → Tools, so a tool looks the same wherever it is listed. Each MCP group shows its status and discovered tool names/descriptions (using live catalog entries when running, or cached discovery data while stopped). Selecting an MCP server stores its server slug, so current and future tools from that server are available to the agent; unchecking individual MCP child tools expands the server slug into the remaining concrete tool IDs (and collapses back to the server slug once every child is checked). All groups checked = inherit everything; unchecking builds an explicit allowlist (and unchecking every tool persists an explicitly empty allowlist rather than snapping back to inherit-all). The tree deliberately has no `Off / Ask / Allow` control: authorization is a project-level setting, so it lives in Settings → Project and the chat view rather than on an agent's allowlist.
- **Thinking** is a dropdown of the presets for the agent's pinned model (from the model's provider-reported `thinking` descriptor) plus "Chat thinking". The first row keeps the chat's level; picking a preset stores `thinkingLevel` on the agent so delegated runs use it even when the chat later changes.
- **Delete** removes the agent. Nothing references agents, so no cleanup is needed.

### Default subagent

The first row under **Settings → Project → Agents** (and on the `#/settings/agents` list) is **Default subagent**. It configures the nested call used when `subagent` is called **without** an `agent` argument. It uses the same editor as a named agent, but has no name and no **Delete**:

- **Instructions** — empty uses the built-in persona (shown as the placeholder): *"You are a focused subagent. Answer only the delegated task. Be concise. …"*
- **Model**, **Thinking**, and **Tools** work exactly as on a named agent; unset, they follow the chat.

It is stored in `.mouaif.json` under `defaultAgent`. When every field is back to its default, the key is removed:

```json
{
  "defaultAgent": {
    "content": "Be terse. Cite file paths.",
    "tools": ["read_file", "search_files"],
    "modelId": "openai/gpt-4o-mini",
    "providerId": "openrouter",
    "thinkingLevel": "low"
  }
}
```

A model or thinking level picked on the approval card for a single run still overrides the default.

### Delegate with `subagent`

The native `subagent` tool accepts an optional `agent` argument matched against the stored names:

```json
{ "task": "Review the staged changes for regressions.", "agent": "reviewer" }
```

The `agent` parameter's description is built per request and enumerates the current agent names, so the model sees exactly what it can call. `agent` only reuses a saved agent; it is not how a subagent is named.

### Subagents made on the fly

A model that wants a named worker for one job (a group's `be-manager`, an `api-reviewer`) does not need a saved agent. It omits `agent` and passes `name`, and optionally `instructions`:

```json
{ "task": "Read the three worker handoffs and write one report.", "name": "be-manager", "instructions": "You are the backend managing agent. Merge your workers' findings." }
```

- **`name`** (up to 64 characters) labels the run: the card's chip, the nested system row, `subagent_status` rows, approval cards and the Agents graph show it. It saves nothing and selects no agent.
- **`instructions`** replace the **Default subagent**'s instructions for this run only. The default's model, thinking and tool allowlist still apply.
- **`tools`** narrows the run's tools, with entries written like an agent's allowlist: exact tool names (`read_file`) or MCP server slugs (`mcp__fs`). It only narrows, by keeping the overlap with what the subagent would get anyway: the parent's offered tools, then the saved agent's or **Default subagent**'s allowlist. An entry that matches nothing left comes back in the result's `ignoredTools` (and in `subagent_status` rows for background runs), so the model knows the subagent did not get it. `[]` gives the run no tools. It is allowed with `agent` too, since it cannot widen anything.
- `instructions` together with `agent` is refused with `EBADINPUT`, because a saved agent brings its own instructions.

```json
{ "task": "Map the HTTP routes.", "name": "be-api-worker", "tools": ["read_file", "search_files", "subagent_publish"] }
```

Tool authorization is unchanged: each call still passes the project's Off / Ask / Allow gate, and its approval card names the subagent.

None of these fields is written to `.mouaif.json`. Before these fields existed, the only way to give a delegated run a role was to pick a saved agent, so parallel workers were all launched as one saved agent (with its persona and tool allowlist) and every card read the same. A `name` on a saved-agent run is still allowed: the card shows the name, and the saved agent's name stays in the chip's tooltip and the graph's detail line. Regression tests: [scripts/test-default-subagent-stream.js](../../scripts/test-default-subagent-stream.js), [scripts/test-agent-network.mjs](../../scripts/test-agent-network.mjs). Images are never inherited: the main model can explicitly pass an `images` array of current-chat `imageRef` values returned by `list_chat_attachments`. Omit it to send only task/context; see [Subagent image generation](./subagent-image-generation.md#send-only-selected-attachments).

### Model defaults and one-run choices

Model selection lives on the agents themselves: each agent's editor, including **Default subagent**, has a **Model** field. Project settings has no subagent model picker. A project (`subagentProviderId` + `subagentModelId` in `.mouaif.json`) or a chat (through the `update_chat` tool) can still carry a subagent default, which applies to agents without a model of their own.

The effective model is resolved in this order:

1. An explicit approval-card pick (this run only).
2. The selected agent’s model pin, or **Default subagent**’s pin when no agent is named.
3. This chat’s subagent default.
4. The resolved project subagent default (project settings override app settings).
5. The chat’s own model.

A named agent does **not** inherit **Default subagent**’s pin. The Agents list shows provider-qualified pins or its inheritance rule. Approval cards state **Runs on provider / model**, including **instead of** the chat model when different, and name the winning source. The displayed default is not an override: changing only thinking does not accidentally select the chat model. **Use default** removes a per-run pick. A broken lower-priority pin cannot block an explicit approval pick; invalid winning pins/defaults fail visibly rather than silently falling back.

The existing picker already supports search, provider chips, project models, live chat/image catalogs, and app-wide pinned/recent models. Both the agent editor and the approval card load the live catalog of every provider connection (`liveModelUnion` in `frontend/src/components/chat/modelPicker.js`), not only the chat's: the chat itself loads just its own provider's catalog, so a card built from it alone could not offer another provider's models. No new model argument is added to `subagent`, and no model catalog or provider configuration is written by browsing.

### Image-generation agents

Pin an agent to an image model, then delegate a drawing task or send `@<agent> <description>`. Native OpenRouter and Gemini artwork appears in the nested transcript and is returned as image blocks to the parent model. Dedicated OpenRouter image models use `/images`; Imagen uses `:predict`; image-capable chat models request image output and parse inline pixels. See [Subagent image generation](./subagent-image-generation.md) for limits and failure behavior.

### Invoke an agent yourself with `@`

You don't have to wait for the model to delegate. In the chat composer, type `@` and pick the agent from the **Agents** section (or type `@<name>`), write the task, and send:

```
@reviewer Check the staged changes for regressions.
```

A leading `@<agent> <task>` dispatches the agent directly through `POST /api/tools/subagent` — the same dispatcher and authorization gate the model-driven path uses. The run shows as a `subagent` tool card pair that names the agent (a chip in the card head and the nested system row's role label), and the agent's answer lands in the transcript as an assistant message. A leading `@<agent>` with no task (or `@` mid-text) sends to the model as plain text. See [at-mention](./at-mention.md) and [subagent-transcript](./subagent-transcript.md).

The call card is opened before the request is made, so the server's call id is not yet known. The card is opened under a placeholder id and **re-keyed to the id the server returns** before its result is appended, which is what lets the result update that card in place instead of rendering a second card beside a spinner that can never resolve. If the request fails outright there is no id to adopt, so the placeholder card is retired and the error is reported on its own result card. Regression test: [scripts/test-agent-command-card.js](../../scripts/test-agent-command-card.js).

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/api/tools/subagent` | `{ projectDir, chatId, task, agent?, context?, modelId?, providerId? }` | `{ ok, id, name, args, result, toolCall }`; 400 on missing task; 403 when the subagent tool is off/denied |
| `GET` | `/api/agents/_default?projectDir=` | — | `{ agent }` — the default subagent (`isDefault`, `content`, `effectiveContent`, `builtinContent`, `tools?`, `modelId?`, `providerId?`, `thinkingLevel?`) |
| `PATCH` | `/api/agents/_default` | `{ projectDir, content?, tools?, modelId?, providerId?, thinkingLevel? }` | `{ agent }`; `DELETE` returns 405 |

`_default` can never collide with a user agent: names must start with a letter or digit.

When a name is provided:

- The nested call's system message is the agent's **instructions** (replacing the generic "focused subagent" persona).
- If the agent has a **tools** allowlist, the nested call is restricted to it.
- If the agent has a **model** pin, the nested call runs on that project or live-catalog model (through its saved provider connection) instead of the chat's model.
- Everything else is inherited from the parent: MCP surface and the authorization gate.

When no name is provided, the [default subagent](#default-subagent) config applies the same way.

An **unknown name returns a typed error** — no silent fallback to a generic subagent:

```json
{ "ok": false, "error": { "code": "EUNKNOWN_AGENT", "message": "Unknown agent \"reviewr\"", "available": ["reviewer"] } }
```

## Cost and usage

Nested agent runs are billed on the effective model selected by the precedence above and added to the parent chat's running total. As each nested round finishes, the streaming layer emits a `usage_update` SSE event carrying that round's increment so the chat header's "Total" pill grows while the delegated run is still working; the parent's `done` event later folds the total into the final segment's remainder. Re-opening the chat shows the same total as a sum of the persisted assistant messages' `cost` fields. See [usage-metrics.md](./usage-metrics.md).

## Related

- [Custom prompts](./custom-prompts.md) — the chat-level persona mechanism.
- [Agent feature prompt and tool](./agent-feature-prompt.md) — how agents surface in `list_features`.
- [Tool authorization](./tool-authorization.md) — the gate the nested call still passes through.
