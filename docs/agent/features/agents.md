# Agents — implementation notes

> Agent-facing reference for [`docs/features/agents.md`](../../features/agents.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Overview

Named and default agents share a provider-qualified model picker. Unpinned runs can opt into chat/project model defaults; approval cards describe the server-resolved choice without implicitly overriding it.

## Usage

Configure defaults in Project settings → Agents (the chat default appears when opened from a chat). Choose or clear pins in the existing agent editor, and use the approval picker for a one-run exception.

### REST

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/agents?projectDir=<abs>` | — | `{ agents: [...] }` |
| `POST` | `/api/agents` | `{ projectDir, name, content, tools?, modelId?, providerId?, thinkingLevel? }` | `{ agent }` (201); 400 on invalid/duplicate name |
| `GET` | `/api/agents/:name?projectDir=<abs>` | — | `{ agent }` or 404 |
| `PATCH` | `/api/agents/:name` | `{ projectDir, name?, content?, tools?, modelId?, providerId?, thinkingLevel? }` | `{ agent }`; `name` is now mutable (renames the agent); empty `modelId` / `providerId` clears the pin; `thinkingLevel: ""` clears the override |
| `DELETE` | `/api/agents/:name?projectDir=<abs>` | — | `{ ok, removed }` |

### Model default wire shapes

- Project defaults: `subagentProviderId` / `subagentModelId` through existing `PUT /api/settings/project` with `{ projectDir, subagentProviderId, subagentModelId }`. Empty strings explicitly mask an app default; app/project settings otherwise resolve using the existing merge. No configuration is applied by this feature’s implementation.
- Chat defaults: the same fields through existing `PATCH /api/chats/:id` or `update_chat`. A nonempty model requires a provider; clearing the model clears both fields. SQLite `chat_store` gains nullable `subagent_provider_id` and `subagent_model_id` columns lazily; list summaries include both fields without loading transcripts.
- `authorization_required` and recovered `authorization.listPending()` carry optional `subagentModel: { providerId, modelId, source }` or `{ error }`. Only identity/source are sent, never provider credentials. Existing approval payload stays `{ modelOverride: { providerId, modelId } }` for a deliberate selection; the untouched/default display sends no override.

## Implementation notes

The mobile agent editor sheet reserves the top safe area at its fixed overlay so it cannot extend beneath the device status bar.

- Storage: `.mouaif.json` under `agents` as `{ name, content, tools?, modelId?, providerId?, thinkingLevel?, createdAt, updatedAt }`. The legacy `agentPresets` key is read as a one-release fallback (its `id` becomes `name`; extra fields like `title`/`promptSize`/`agentFiles` are dropped, `modelId` is kept) and removed on first write.
- `agents.resolveSubagentModel()` resolves only the winning identity: approval → selected agent pin (defaultAgent only for an unnamed call) → chat subagent default → resolved project subagent default → hydrated chat model. `subagentModelForCall()` supplies the stored agent/chat/resolved settings for both approval display and dispatch. Invalid winners retain typed errors; an override skips invalid lower-priority model pins but not an unknown agent persona.
- `SubagentModelDefaults.jsx` reuses `ModelPickerField`, loads both catalog purposes across configured providers, and never saves on mount. `AuthModelPicker.jsx` keeps the display default separate from its nullable override, including thinking-only edits. The card continues working with an empty catalog or a ghost pin.
- The model pin resolves at dispatch time: `agents.resolveModel()` first finds a matching project model by provider + id, then accepts a provider-qualified live-catalog identity. The subagent dispatcher hydrates either with the app-level provider connection; credentials never come from the project file.
- The thinking override resolves in the subagent dispatcher (`src/ai-stream.js`): the authorization card's per-run value wins, then the agent's `thinkingLevel`, then the chat's inherited value. An empty string clears the inherited level so "No thinking" is honoured explicitly.
- Direct invocation (`POST /api/tools/subagent`) reuses the model loop's single-call runner `ai.runSingleToolCall()` — circuit breaker, authorization gate, and dispatcher are shared, so behavior matches a model-initiated call exactly. The chat's current model (and its `thinkingLevel`) is the default when the agent has no pin and no explicit `modelId` is passed.
- The 64 KiB cap is applied on write; oversized content is truncated with a trailing `[... truncated ...]` note.
- The feature summary reports `[agents] N available`; the `list_features` tool and `GET /api/features` report `agents: { discovered: [{ name }] }`.
- Source: `src/agents.js`, `src/index.js` (`handleAgents`), `src/ai-stream.js` (subagent dispatch + spec builder), `src/tools/subagent.js`, `frontend/src/components/SettingsAgents.jsx` (list + edit views, routed at `#/settings/agents[/<name>]`), `frontend/src/components/SettingsProject.jsx` (agent list rows + inline create; rows link to the standalone editor). The agent model pin uses the shared `frontend/src/components/ModelPickerField.jsx`; the thinking override uses `frontend/src/components/ThinkingSelectField.jsx`.

Agent routes carry `projectDir`, optional `chatId`, and `from=projects|settings/projects`. Editors opened directly from project settings also carry `returnTo=project`; other editors return to the dedicated agent list. `#/settings/agents/new` creates an agent, while `#/settings/agents/new?edit=1` edits an existing agent named `new`. Legacy `settings/project/agents/<name>` links keep their project-settings return target.

The editor uses phone-sized touch targets for Back and tool selection. It loads agent data independently of model catalogs, so an unavailable provider does not block the form. The auto-save queue merges pending patches, serializes requests, and uses the latest persisted name after a rename. In-app unmounts flush pending edits without redirecting the newly opened page; failed saves require a retry. Closing the browser during an unfinished request cannot guarantee persistence—wait for **saved** or use **Back**.

Run the focused regression suite with:

```bash
node scripts/test-agent-page-flow.mjs
npm run test:subagent-model-choice
npm run test:subagent-prompt
```

## Track C landing handoff

Track C adds no tool names; keep the baseline tool-group inventory unchanged. Rebase after A/E before landing and rerun model-choice, subagent-prompt, authorization, tool-groups, and docs checks. Shared conflict surfaces are `src/ai-stream.js` (A/D dispatch), `src/tools/authorization.js` (A/E pending requests), `src/tools/appToolNames.js` / `mouaif.js` (E chat fields), and `frontend/src/components/chat/cards.js` (A/D/B approvals). Preserve `subagentModel` through live and recovered approvals and retain the nullable per-run override. Regenerate committed frontend assets after conflict resolution, not by merging old hashes.

Local source/build verification uses temporary stores and mocked providers only. No live model/provider settings are changed. Existing search, provider chips, pins/recents, and default-agent editor are reused rather than reimplemented.
