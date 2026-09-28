# Read tools and Edit tools — implementation notes

> Agent-facing reference for [`docs/features/read-edit-tool-groups.md`](../../features/read-edit-tool-groups.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### Why the split exists

The five native file operations used to render as one **File tools** group. Read-only intent (let the model inspect the project, never write it) then required expanding the group and unchecking two leaves by hand, and a collapsed row could not show read-only vs read-write at a glance. Splitting them by **effect** makes read-only a single gesture.

The split is **presentation only**. Authorization is unchanged: one project `tools.file` family gate plus optional per-leaf `tools.<name>` overrides, resolved in `src/tools/authorization.js`. No server module, REST shape, or stored setting changed.

### The classification helper

[`frontend/src/components/settings/fileToolGroups.js`](../../../frontend/src/components/settings/fileToolGroups.js) is the single source of truth:

```js
export const READ_GROUP_ID = 'files-read';
export const EDIT_GROUP_ID = 'files-edit';
export const READ_TOOL_NAMES = ['read_file', 'list_files', 'search_files'];
export const EDIT_TOOL_NAMES = ['write_file', 'edit_file'];
export const FILE_TOOL_NAMES = [...READ_TOOL_NAMES, ...EDIT_TOOL_NAMES];

partitionFileTools(tools); // -> { read: [...], edit: [...] }
groupMeta(kind);           // -> { id, name, description }
isFileToolName(name);      // -> bool
```

- `partitionFileTools` accepts either shape the builders feed it: catalog rows (`.name`) or agent choices (`.value`).
- **An unclassified file tool lands in `edit`.** A future mutating tool must never be silently filed as read-only.
- `groupMeta('read')` / `groupMeta('edit')` return the shared row labels (`Read tools` / `read, list, search`, `Edit tools` / `write, edit`). Any non-`'read'` argument is the edit half — the same safe default.

### Tree builders

All three call `partitionFileTools` and push one row per non-empty half, so a surface with no file tools in the catalog draws no file row:

| Builder | File | Used by |
|---|---|---|
| `buildToolGroups(catalog, mcpServers, filter, usedTools)` | [`frontend/src/components/ToolTree.jsx`](../../../frontend/src/components/ToolTree.jsx) | chat tools card (`chat/cards.js`), composer popup (`chat/ToolPopup.jsx`), chat preset (`SettingsPrompts.jsx`) |
| `buildAgentToolGroups({ choices, restricted, selected, mcpServers, catalog })` | same file | agent editor (`SettingsAgents.jsx`) |
| `buildSettingsToolGroups(catalog)` | [`frontend/src/components/SettingsProject.jsx`](../../../frontend/src/components/SettingsProject.jsx) | Settings → Project |

### Authorization wiring

The two rows are two controls over ONE family, which has two consequences:

1. **Both segments edit the same key.** In `chat/cards.js` and `chat/ToolPopup.jsx`, the `toolByGroup` / `segNames` maps resolve *both* `files-read` and `files-edit` to the `file` authorization key, so the segment on either row reads and writes the same mode. In `buildSettingsToolGroups`, both rows pass `segMode(fileAuth.mode)` and `pickFileMode`, so either segment sets the family mode.

2. **The rows must not share a radio group.** `ToolAuthSeg`'s radio `name` comes from its `tool` prop. Two rows with `tool: 'file'` would be one browser radio group, so picking a mode on Read tools would visibly clear Edit tools. Both rows therefore pass the **row id** as the radio identity and the **family key** as the aria label:
   - `chat/cards.js` passes `tool: g.id` (`files-read` / `files-edit`).
   - `chat/ToolPopup.jsx`'s `AuthSegment` takes a `rowId` prop and passes `tool: rowId || toolName`.
   - `toolModeSegs(name, activeMode, onPick, modes, rowId)` (both in [`frontend/src/components/settings/toolAuth.js`](../../../frontend/src/components/settings/toolAuth.js) and the settings-only [`frontend/src/components/settingsProjectUi.js`](../../../frontend/src/components/settingsProjectUi.js)) takes the same fifth `rowId` argument, defaulting to `name` so every other row is unchanged.

### Group checkboxes

- **Chat surfaces** (`buildToolGroups`): the group checkbox toggles that half's ids in the per-chat `tools` filter, exactly like any other group — `cards.js`/`ToolPopup.jsx` send `group.tools.map(t => t.id)` through the existing `_toggleToolGroup` / `onToggleToolGroup`.
- **Settings** (`buildSettingsToolGroups`): the group checkbox writes **per-leaf** `tools.<name>` overrides via `pickFileLeavesMode(names, mode)` and leaves `tools.file` alone. The old `pickFileGroupMode` also wrote the family, which would have made unchecking Read tools gate the Edit half too — the opposite of the split. The row's `checked` flag is computed from **that half's** effective leaf modes (`fileToolAuth[t.name].mode || fileAuth.mode`), not the family, so an off Read half leaves Edit checked.

### Tests

- `npm run test:file-tool-groups` — `scripts/test-file-tool-groups.js`: the classification, both input shapes, the edit-half default for an unknown tool, and the stable ids.
- `scripts/test-tool-auth-segment.mjs` §5 — the two file rows use **different radio names** keyed on the row id, both chat maps resolve to the `file` family, and the settings group checkbox writes per-leaf overrides rather than the family.
- `scripts/test-project-settings-render.mjs` — renders the real settings component with a file-tool catalog and asserts two rows (`files-read` / `files-edit`) replace the old `files` group, with disjoint leaves and distinct segment identities.
