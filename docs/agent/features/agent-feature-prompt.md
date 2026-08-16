# Agent feature prompt and tool — implementation notes

> Agent-facing reference for [`docs/features/agent-feature-prompt.md`](../../features/agent-feature-prompt.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## REST

| Method | Path | Query | Response |
|--------|------|-------|----------|
| `GET` | `/api/features` | `?projectDir=<abs>` | `{ features: { tools, mcp, agentFiles, agentSkills, fileTagging, trace, promptProfile } }` |

The REST endpoint returns the same structured state the `list_features` tool returns, without requiring a chat to be active.

## Implementation notes

- Source: `src/agentFeatures.js` (new module). Public surface:
  - `buildFeatureSummary({ chat, projectDir, project, authz, mcpServers })` → string or null
  - `LIST_FEATURES_SPEC` — tool spec object
  - `dispatchListFeatures(args, opts)` → `{ ok, content, result }`
- Injection happens in `src/index.js` `handleChatStream`, after agent files and before tagged files. The call collects the project record, authorization state, and MCP server list, then passes them to `buildFeatureSummary`.
- Tool registration in `src/ai.js`:
  - `LIST_FEATURES_SPEC` is pushed into the `toolSpecs` array alongside `shell`, `subagent`, `ask_user`, and file tools.
  - In `runOneCall`, `list_features` is handled before the authorization gate (alongside `discover_tool`) so it never triggers an authorization prompt.
  - In `dispatchTool`, `list_features` is dispatched before the file tools, returning the structured JSON state.
- The REST endpoint `GET /api/features` is registered in `src/index.js` as a standalone route so the UI can inspect the feature state without a chat.
