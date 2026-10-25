# Tool wording — implementation notes

> Agent-facing reference for [`docs/features/tool-overrides.md`](../../features/tool-overrides.md).

### Storage

Resolved project setting `toolWording` (`DEFAULTS.toolWording = { active: '', sets: {} }` in `src/settings.js`), written whole with `PUT /api/settings/project { projectDir, toolWording }` on Save:

```
toolWording = { active: "<set id>" | "", sets: { "<set id>": { name, tools: OVERRIDES } } }
OVERRIDES   = { "<tool>": { description?: string, fields?: { "<field>": "<new name>" } } }
```

- `active: ""` is Built-in.
- Set ids are slugs of the name at creation and never change, so renaming a set keeps it active.
- A copy of Built-in stores every tool's description: it is a full snapshot, not a diff.
- Legacy flat `toolOverrides` (`DEFAULTS.toolOverrides = {}`, one OVERRIDES map) applies only while a project has no sets (`activeOverrides`).
- The page shows a legacy map as the active set `custom` ("Custom"). Its first Save sends `unset: ['toolOverrides']` along with `toolWording`.

### Sources

| Path | Role |
| --- | --- |
| `src/toolOverrides.js` | `normalize` (defensive read); `activeOverrides(resolved)` (the active set's tools, `{}` for Built-in or a missing id, else the legacy map when there are no sets); `overridesFor(projectDir)`; `prune(specs, overrides)` (drops tools that are not advertised, unknown fields, and renames onto an existing field); `applyToSpecs` (returns copies — the `SPEC` constants are shared and never mutated); `restoreArgs` (renames a call's arguments back). |
| `src/ai-stream.js` | Runs after every authorization/`enabledTools` filter: `toolSpecs` is replaced by the re-worded copies. `runSingleToolCall` runs `restoreArgs` right after parsing the arguments, so authorization, cards, dispatch and the circuit breaker all see original names. `singleToolCall` (composer) skips both. |
| `frontend/src/components/settings/toolOverrides.js` | Pure client helpers. Overrides: `normalizeOverrides`, `fieldProblem`, `renameProblems`, `fieldList`, `searchTools`, `changedTools`. Sets: `normalizeWording`, `wordingFromResolved` (legacy → `custom`), `newSetId`, `uniqueSetName`, `snapshotBuiltIn`, `effectiveEntry`, `differsFromBuiltIn`, `wordingChanges` (the Save bar summary). Import/export: `parseImport` (a `{ name, tools }` set, a bare map, a legacy file or a list), `exportText(set)`. Diff: `diffWords`/`diffStats` (word LCS after trimming the common prefix and suffix; above 4M cells the middle becomes one replaced span). |
| `frontend/src/components/ToolOverridesPage.jsx` | The page (detail below). |
| `frontend/src/routes.js`, `components/App.jsx` | Route `settings/project/tool-overrides` → `settingsProjectToolOverrides` (lazy). |
| `frontend/src/components/SettingsProject.jsx` | The **Tool wording** link row under the tool tree. |

`ToolOverridesPage.jsx` in more detail:

- **State.** `ToolOverridesPageView` holds `saved` and `draft` wording, plus `tab` (`builtin` / `set` / `compare`), `editingId` (the set picked in the management dropdown above the tabs, held as `chosen`; it moves to another set when one is deleted, and `pickSet` also switches to the middle tab, which is labelled with its name). All set management, including the `panel` (`new` / `import`) forms, renders above the tabs; the tabs only choose what the rows show and the two Compare sides.
- **Rows.** `ToolRow` renders in `builtin`, `set` or `compare` mode. Each row's `open` state lives on the page, so a remount (revert, remove, discard) keeps the row open.
- **Editing.** `SetDescription` keeps only a local `editing` flag, so **Start blank** can open a box that is not yet a change.
- **Data and saving.** It reads `GET /api/tools/list?projectDir=` (built-in wording, never overridden) and `/api/settings/resolved`. Save sends one PUT, and `renameProblems` keeps Save off while a rename breaks the rules. `beforeunload` and the page's own links warn while changes are unsaved.

### Tests

- `scripts/test-tool-overrides.js` — normalization, prune, copy-not-mutate apply, restore, legacy vs active-set resolution, `ai-stream` wiring.
- `scripts/test-tool-overrides-ui.mjs` — the page's helpers (sets, snapshot, change summary, import/export round trip), route/App/link wiring.
- `scripts/test-routes.js` pins the route.
