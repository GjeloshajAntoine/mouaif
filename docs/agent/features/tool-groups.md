# Tool groups — implementation notes

> Agent-facing reference for [`docs/features/tool-groups.md`](../../features/tool-groups.md).

## Implementation notes

### Where the model lives

`frontend/src/toolGroups.js` is the single source: a frozen `TOOL_GROUPS` array plus `GROUP_BY_ID`, `FAMILY_OF` (leaf → gate for every multi-tool family), and the helpers (`groupAuthKey`, `groupTools`, `toolGroupId`, `isBinaryTool`, `isFamilyLeaf`, `isGatedTool`, `toolPermission`). There is one group kind: every gated row has an `authKey`; a multi-tool family (`file`, `chats`, `mouaif`) uses one key for all its leaves. It is an ES module (the UI's own source), so the server gets it through a generated mirror instead of a `require`.

`frontend/src/components/ToolTree.jsx` imports it and re-exports the pieces its callers already used (`TOOL_GROUPS`, `groupAuthKey`, `toolPermission`).

### Consumers

| Surface | Reads | Resolves a row's gate with |
|---|---|---|
| `chat/cards.js` | `buildToolGroups` + `groupAuthKey` / `isBinaryTool` | the model, not a local `toolByGroup` map |
| `chat/ToolPopup.jsx` | `buildToolGroups` + `groupAuthKey` | the model |
| `SettingsProject.jsx` | `TOOL_GROUPS` | `group.authKey`; builds one `toolAuth` map keyed by auth key instead of eight per-tool `useState` pairs |
| `SettingsAgents.jsx` | `TOOL_GROUPS.flatMap(tools)` for the allowlist choices; rows from `buildAgentToolGroups` | n/a (an allowlist has no modes) |

`buildAgentToolGroups` no longer hard-codes `files` / `APP_TOOL_NAMES` / a per-tool loop for single-tool groups: it iterates `TOOL_GROUPS` in order. That is what makes a move a one-line change.

### Server families

`src/tools/authorization.js` builds `TOOL_FAMILIES` (`file` from `files.js`, `chats` / `mouaif` from each app tool's `source` in `appToolNames.js`), `FAMILY_OF` (leaf → gate), `FAMILY_TOOLS` (every leaf) and `familyTools(gate)`. `configToolName`, `effectiveConfig`, `readChatAuthOverrides`, `setAuthorization` and `getAuthorization` all go through those, so the leaf-override precedence that used to be `file`-only applies to every family. The advertisement filters in `src/ai-stream.js` and `src/server-handlers-chats.js` hide `familyTools(gate)` on a gate `off`, then resolve each family leaf. `scripts/test-tool-groups.mjs` asserts the server families and the UI's multi-tool groups have the same keys and leaves.

### Server mirror + generated file

- `scripts/build-tool-groups.js` strips `export`/`import` from the ES module and evaluates it with `new Function`, then writes `frontend/build/toolGroups.json` (committed). `--check` fails when the mirror is stale.
- `src/toolGroups.js` reads the mirror lazily (cached), with a small `FALLBACK` of the Chats / mouaif families, and exposes `groups()`, `summaryLine(id, catalog, authTools)`, `summaryLines(catalog, authTools, skip)`.
- `src/agentFeatures.js` prints one `[<row>](off|ask|allow) → <mode> — <leaves>` line per multi-tool family (skipping `file`, which keeps its own line); a gate `off` drops the line and a leaf `off` drops that leaf. `nativeCatalog` comes from `listNativeTools()` in `src/server-handlers-tools.js`, a new export factored out of the `GET /api/tools/list` handler so the summary and the endpoint can never disagree.
- `scripts/prepare-web.js` calls `ensureToolGroups()` before the Vite build, mirroring `ensureIcons()`, so a source checkout regenerates the mirror on install.

### Adding a group or a tool

Add the entry (or the name) to `TOOL_GROUPS`, run `node scripts/build-tool-groups.js`, then extend the two feature docs. A native tool that is not in the model is invisible to every tree — `scripts/test-tool-groups.mjs` asserts the model covers the whole `listNativeTools()` catalog, so this fails loudly rather than silently.

### Group ids are load-bearing

A group `id` is the tree row key and the id the settings toggle handlers switch on (`toggleSettingsGroup`, the popup's `handleToggleGroup`). `groupAuthKey(id)` is the only rule that maps a row to the gate it writes; no surface compares against a literal group id except for the MCP prefix (`mcp-`), the synthetic `skills` / `agent-files` rows, and the preset tree's own ids.

### Testing

```bash
node scripts/test-tool-groups.mjs               # the model + the generated mirror
node scripts/test-tool-authorization.js         # family gates on the server
node scripts/test-mouaif-tool-categories.mjs    # the Chats / mouaif rows and their children
node scripts/test-mouaif-tool-toggle.mjs        # the chat filter write path
node scripts/test-project-settings-render.mjs   # the settings tree, per-row status lines
node scripts/test-project-settings-ui.mjs       # the browser regression (Chrome)
node scripts/test-tool-tree-layout.mjs          # alignment at 360–1280px
```
