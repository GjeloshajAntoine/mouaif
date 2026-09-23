# Agents — implementation notes

> Agent-facing reference for [`docs/features/agents.md`](../../features/agents.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### REST

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/agents?projectDir=<abs>` | — | `{ agents: [...] }` |
| `POST` | `/api/agents` | `{ projectDir, name, content, tools?, modelId?, providerId?, thinkingLevel? }` | `{ agent }` (201); 400 on invalid/duplicate name |
| `GET` | `/api/agents/:name?projectDir=<abs>` | — | `{ agent }` or 404 |
| `PATCH` | `/api/agents/:name` | `{ projectDir, name?, content?, tools?, modelId?, providerId?, thinkingLevel? }` | `{ agent }`; `name` is now mutable (renames the agent); empty `modelId` / `providerId` clears the pin; `thinkingLevel: ""` clears the override |
| `DELETE` | `/api/agents/:name?projectDir=<abs>` | — | `{ ok, removed }` |

## Implementation notes

The mobile agent editor sheet reserves the top safe area at its fixed overlay so it cannot extend beneath the device status bar.

- Storage: `.mouaif.json` under `agents` as `{ name, content, tools?, modelId?, providerId?, thinkingLevel?, createdAt, updatedAt }`. The legacy `agentPresets` key is read as a one-release fallback (its `id` becomes `name`; extra fields like `title`/`promptSize`/`agentFiles` are dropped, `modelId` is kept) and removed on first write.
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
```
