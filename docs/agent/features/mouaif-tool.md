# mouaif tool — implementation notes

> Agent-facing reference for [`docs/features/mouaif-tool.md`](../../features/mouaif-tool.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### Shape

Twelve ordinary native specs, five business areas, **two visual categories**. `src/tools/appToolNames.js` defines operation names, schema fields and catalog sources. `src/tools/mouaif.js` exports `SPECS`, `TOOL_NAMES`, and `runAppTool(name, args, opts)`. The area router is internal business-code reuse, not a model-facing function.

`MOUAIF_TOOL_GROUPS` groups real catalog functions by `source` (`chats` or `mouaif`). Child ids are function names; each child has the normal `ToolAuthSeg` control. Categories are presentation only.

### Child row → tool name

Every child id equals its native function name. `knownToolNames` reads the catalog directly, with no aliases or action-key expansion. Legacy selections are converted once by `src/migrateAppTools.js` at startup.

The resolution lives in one shared pair, exported from `ToolTree.jsx`:

```js
groupToolNames(group)  // Chats -> ['list_chats', 'get_chat', …]
childToolName(group, toolId)  // 'get_app_info' -> 'get_app_info'
```

`buildToolGroups` also accepts effective native/MCP permissions; `toolPermission` keeps Off tools unchecked even when the chat filter is `null`. `toggleToolGroup` saves the filter and, when enabling a disabled tool, restores its chat-scoped gate to Ask. Both chat surfaces re-render after success or failure. Each function has its own radio name and stored permission, on the leaf rather than a shared category gate.

Both chat surfaces call them (`cards.js` passes the result to `state._toggleTool` / `state._toggleToolGroup`, `ToolPopup.jsx` to its `onToggleTool` / `onToggleToolGroup` props), and `SettingsProject.jsx` carries `toolName` on its own inline rows. Do not re-inline the rule at a call site: the first fix did exactly that, landed in the popup and missed the card, and the card's action checkboxes were dead until `groupToolNames`/`childToolName` gave the two surfaces one home. `scripts/test-mouaif-tool-toggle.mjs` asserts both surfaces import and call the helpers, and fails if either re-inlines the logic.

```js
const { runAppTool } = require('mouaif/src/tools/mouaif.js');

const out = await runAppTool(
  'create_chat', { title: 'Changelog', topic: 'draft the notes' },
  { projectDir: '/abs/path/to/project', chatId: '3e6fabe3' }
);
// -> { ok: true, content: '<JSON string>', result: { ok: true, projectDir, chat, url } }
```

### Where it is wired

| Concern | File | Detail |
| --- | --- | --- |
| Spec for the model | `src/ai-stream.js` | Pushed right after `restart_app`; `off` mode prunes it in the same loop as the other native families. |
| Dispatch | `src/ai-stream.js` `dispatchTool` | Dispatches names in `TOOL_NAMES` to `runAppTool`, like the grouped native file tools. |
| REST catalog | `src/server-handlers-tools.js` | Each spec is its own entry in `GET /api/tools/list`. |
| Tool preview | `src/server-handlers-chats.js` | Same family list in the `off`-pruning loop. |
| Authorization family | `src/tools/authorization.js` | Member of `NATIVE_TOOLS`; own row in the `getAuthorization` view. Default mode `ask`. |
| Prompt presets | `src/prompts.js` | Member of `PRESET_TOOL_NAMES`. |
| Feature summary | `src/agentFeatures.js` | Own line in `buildFeatureSummary`; in the `list_features` tool list. |
| Chat UI | `frontend/src/components/chat/{cards.js,ToolPopup.jsx,useChatState.js}` | Ordinary child checkboxes and per-leaf permission controls in two visual categories. |
| Project settings UI | `frontend/src/components/SettingsProject.jsx` | Each checkbox/control writes `tools.<functionName>`. |
| Agent allowlist UI | `frontend/src/components/SettingsAgents.jsx` | Twelve ordinary function-name choices. |
| Card rendering | `frontend/src/components/chat/{tools.js,toolRender.js}` + `frontend/src/tool-cards.css` | `mouaifArgSummary` for the collapsed head; `renderMouaifToolResult` renders a chat list, everything else falls through to the JSON preview. |

### `opts` the runner reads

| Key | Use |
| --- | --- |
| `projectDir` | Required. Validated with `projects.ensureSafeRoot` (absolute + under the user home unless `MOUAIF_ALLOW_ANY_ROOT=1`). |
| `chatId` | Default for `get` / `attach` / `list_attachments`. |
| `chat` | Full chat record when the caller already has it (`info`). |
| `signal` | Unused today; the areas are all fast, local calls. |

### Areas and the modules they call

| Area | Actions | Internal calls |
| --- | --- | --- |
| `chats` | `list`, `search`, `get`, `create`, `update`, `delete` | `chats.listChats/countChats/searchChats/getChat/createChat/updateChat/deleteChat`, `messages.listMessagesWindow/getMessageCount` |
| `attachments` | `attach`, `list_attachments` | `files.readMedia`, `messages.normalizeAttachments/appendMessage/newClientId`, `chats.updateChat` (`draftAttachments`) |
| `settings` | `settings_get`, `settings_update` | `settings.getApp/getProject/setApp/setProject/unsetProjectKeys`, `server-shared.settingsForClient/projectForClient/sanitizeClientEntries` |
| `projects` | `project_list` | `projects.listProjects` |
| `info` | `info` | `agentFeatures.dispatchListFeatures` |

### Action filtering

Specs, tool filters, discovery, subagents and permissions use the same native-name paths as shell/task and other built-ins. `selectedSpec`, action enums and custom permission resolution are removed. A one-time migration converts legacy config in app/project settings, chat filters and toolAuth, agents, prompts and pinned prompt snapshots; explicit new-name settings win.

### Read results

`chatSummary` preserves `draftSnippet` from the lightweight chat-list projection, plus search `matchField` and `snippet`, without loading full draft bodies. Both `info` and `list_features` resolve native permissions with `getAuthorization(projectDir, chatId)` so their report agrees with the execution gate.

`list_attachments` scans at most 200 messages per page (`limit`, default 200), using `messages.listMessagesWindow` with one lookahead row. `nextBeforeSeq` is the oldest scanned sequence when older rows exist; otherwise it is `null`. Feed it back as the non-negative integer `beforeSeq`. Pages without images still carry the cursor; draft image metadata is repeated on each page. Results never contain image bytes.

### Attachment rules

`attach` reads the file with `files.readMedia` (default cap 1 MiB, this tool asks for 6 MiB) and builds the only attachment shape the chat store accepts:

```js
{ type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,…', name: 'shot.png' }
```

`messages.normalizeAttachments` is the gate: `png|jpe?g|webp|gif` only, at most 8 per chat, and the base64 data URL must stay under 12 MB of characters. Target `draft` merges into `chat.draftAttachments`; target `message` appends a `role: 'user'` row through `messages.appendMessage`. Nothing starts a turn — the user still presses send.

### Errors

`runMouaif` never throws; it returns a typed envelope. Area functions throw `typedError(code, message)`, the router catches, and the result becomes `{ ok: false, code, message }` with `path` when the error carries one.

### Validation and synchronization

`runMouaif` validates the published argument schema before dispatch, including enums, object/array shapes, item types, and unknown properties. Chat model selection calls the REST `resolveModel` helper but persists only identity, never hydrated credentials. Creation validates before writing; prompt updates reject missing prompts. Empty `modelId` clears the model and provider.

Settings use the REST projections in both scopes, hiding credentials and `__dbBacked`. Credential patches are rejected at top level and inside provider/model entries. `sanitizeClientEntries` preserves existing secrets during redacted round-trips without persisting `hasApiKey` or mutating caller arguments. Project `unset` follows `patch`, matching REST precedence.

`applyMouaifToolResult` in `frontend/src/components/chat/meta.js` refreshes the mounted chat after successful mutations. Both the owner SSE and incremental follower/recovery tail call it. It deduplicates call ids with a bounded set, coalesces fields across overlapping refreshes, rejects stale chat/session responses, and preserves concurrent composer edits. Setters exposed by `useChatState.js` update draft text and image state; metadata merges only changed fields. Changes to other chats invalidate the project list without reloading the current record.

### Tests

```bash
npm run test:mouaif-tool
```

`node scripts/test-mouaif-tool.js` (also wired into `npm test`, and `node -c`'d by `npm run lint`). Assertions cover the spec shape, the authorization family, every action, validation before writes, model/prompt selection, draft/search previews, paginated attachment inventories, chat-scoped feature state, redacted settings round-trips, and DB-backed projection. The temp project dir must live under the real user home because of `projects.ensureSafeRoot` — same convention as `scripts/test-file-editor.js`.

`test-mouaif-tool-stream.js` exercises the actual multi-turn dispatcher, tool-result cards, Allow/Ask/Off and per-chat authorization, denial, typed errors, credential redaction, draft attachment, and confirmed deletion. `test-mouaif-tool-sync.mjs` executes the production refresh helper with deferred responses to cover drafts/images, title/model/prompt synchronization, duplicate results, chat/session navigation, overlapping requests, and concurrent user edits.

`node scripts/test-mouaif-tool-toggle.mjs` covers the tree half: the two category rows, their action children, and the child row → tool name resolution (`groupToolNames` / `childToolName`) driven through the real `toggleToolGroup` write path, plus a source assertion that both chat surfaces import and call the shared helpers instead of re-inlining them. `node scripts/test-mouaif-tool-categories.mjs` covers the rendered shape.
