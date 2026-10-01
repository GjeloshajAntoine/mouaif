# mouaif tool — implementation notes

> Agent-facing reference for [`docs/features/mouaif-tool.md`](../../features/mouaif-tool.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### Shape

One spec, five areas, twelve actions, **two UI categories**. `src/tools/mouaif.js` exports `SPEC`, `ACTIONS` (action → area), `AREAS` (one-line description per area), `GROUPS` (the two UI categories — each lists the areas it covers and the `actions` derived from them), `ACTION_NAMES`, and `runMouaif(args, opts)`.

`MOUAIF_TOOL_GROUPS` in `frontend/src/components/ToolTree.jsx` is the frontend copy of `GROUPS`: it carries the per-action child labels and is what `buildToolGroups` / `buildSettingsToolGroups` iterate to render one category row with its actions as children. Keep the two in sync when an area moves between categories — `scripts/test-mouaif-tool.js` asserts the server-side table covers every area and every action exactly once, and `scripts/test-mouaif-tool-categories.mjs` asserts the rendered shape (two categories, action children, every child resolving to the one `mouaif` tool).

```js
const { runMouaif } = require('mouaif/src/tools/mouaif.js');

const out = await runMouaif(
  { action: 'create', title: 'Changelog', topic: 'draft the notes' },
  { projectDir: '/abs/path/to/project', chatId: '3e6fabe3' }
);
// -> { ok: true, content: '<JSON string>', result: { ok: true, projectDir, chat, url } }
```

### Where it is wired

| Concern | File | Detail |
| --- | --- | --- |
| Spec for the model | `src/ai-stream.js` | Pushed right after `restart_app`; `off` mode prunes it in the same loop as the other native families. |
| Dispatch | `src/ai-stream.js` `dispatchTool` | `if (name === 'mouaif') return await mod.runMouaif(args, callOpts)`. Placed before the `task` branch. |
| REST catalog | `src/server-handlers-tools.js` | `pushNativeTool(tools, { load: './tools/mouaif.js', name: 'mouaif', source: 'mouaif', … })` — appears in `GET /api/tools/list`. |
| Tool preview | `src/server-handlers-chats.js` | Same family list in the `off`-pruning loop. |
| Authorization family | `src/tools/authorization.js` | Member of `NATIVE_TOOLS`; own row in the `getAuthorization` view. Default mode `ask`. |
| Prompt presets | `src/prompts.js` | Member of `PRESET_TOOL_NAMES`. |
| Feature summary | `src/agentFeatures.js` | Own line in `buildFeatureSummary`; in the `list_features` tool list. |
| Chat UI | `frontend/src/components/chat/{cards.js,ToolPopup.jsx,useChatState.js}` | One category row per half (`mouaif`, `mouaif-settings`) with an action child row each and a segment on the category; every row maps to the one `mouaif` family. Child toggles resolve through `tool.toolName`. |
| Project settings UI | `frontend/src/components/SettingsProject.jsx` | The same two categories, built inline (they carry the per-row validation status); a child checkbox routes to `pickMouaifMode`. |
| Agent allowlist UI | `frontend/src/components/SettingsAgents.jsx` | `mouaif` choice. |
| Card rendering | `frontend/src/components/chat/{tools.js,toolRender.js}` + `frontend/src/tool-cards.css` | `mouaifArgSummary` for the collapsed head; `renderMouaifToolResult` renders a chat list, everything else falls through to the JSON preview. |

### `opts` the runner reads

| Key | Use |
| --- | --- |
| `projectDir` | Required. Validated with `projects.ensureSafeRoot` (absolute + under the user home unless `MOUAIF_ALLOW_ANY_ROOT=1`). |
| `chatId` | Default for `attach` / `list_attachments`. |
| `chat` | Full chat record when the caller already has it (`info`). |
| `signal` | Unused today; the areas are all fast, local calls. |

### Areas and the modules they call

| Area | Actions | Internal calls |
| --- | --- | --- |
| `chats` | `list`, `search`, `get`, `create`, `update`, `delete` | `chats.listChats/countChats/searchChats/getChat/createChat/updateChat/deleteChat`, `messages.listMessagesWindow/getMessageCount` |
| `attachments` | `attach`, `list_attachments` | `files.readMedia`, `messages.normalizeAttachments/appendMessage/newClientId`, `chats.updateChat` (`draftAttachments`) |
| `settings` | `settings_get`, `settings_update` | `settings.getApp/getProject/setApp/setProject/unsetProjectKeys`, `server-shared.settingsForClient` |
| `projects` | `project_list` | `projects.listProjects` |
| `info` | `info` | `agentFeatures.dispatchListFeatures` |

### Attachment rules

`attach` reads the file with `files.readMedia` (default cap 1 MiB, this tool asks for 6 MiB) and builds the only attachment shape the chat store accepts:

```js
{ type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,…', name: 'shot.png' }
```

`messages.normalizeAttachments` is the gate: `png|jpe?g|webp|gif` only, at most 8 per chat, and the base64 data URL must stay under 12 MB of characters. Target `draft` merges into `chat.draftAttachments`; target `message` appends a `role: 'user'` row through `messages.appendMessage`. Nothing starts a turn — the user still presses send.

### Errors

`runMouaif` never throws; it returns a typed envelope. Area functions throw `typedError(code, message)`, the router catches, and the result becomes `{ ok: false, code, message }` with `path` when the error carries one.

### Tests

`node scripts/test-mouaif-tool.js` (also wired into `npm test`, and `node -c`'d by `npm run lint`). 62 assertions over the spec shape, the authorization family, every action, the error codes, the attachment rules, and the settings projections. The temp project dir must live under the real user home because of `projects.ensureSafeRoot` — same convention as `scripts/test-file-editor.js`.
