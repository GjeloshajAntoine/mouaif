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
| `frontend/src/components/settings/toolOverrides.js` | Pure client helpers. Overrides: `normalizeOverrides`, `fieldProblem`, `renameProblems`, `fieldList`, `searchTools`, `changedTools`. Sets: `normalizeWording`, `wordingFromResolved` (legacy → `custom`), `newSetId`, `uniqueSetName`, `snapshotBuiltIn`, `initialSelection`, `selectionAfterDelete`, `newSetTools`, `effectiveEntry`, `differsFromBuiltIn`, `wordingChanges` (the Save bar summary). Import/export: `parseImport` (a `{ name, tools }` set, a bare map, a legacy file or a list), `exportText(set)`. Diff: `diffWords`/`diffStats` (word LCS after trimming the common prefix and suffix; above 4M cells the middle becomes one replaced span). |
| `frontend/src/components/ToolOverridesPage.jsx` | The page (detail below). |
| `frontend/src/routes.js`, `components/App.jsx` | Route `settings/project/tool-overrides` → `settingsProjectToolOverrides` (lazy). |
| `frontend/src/components/SettingsProject.jsx` | The **Tool wording** link row under the tool tree. |

`ToolOverridesPage.jsx` in more detail:

- **State.** `ToolOverridesPageView` holds `saved` and `draft` wording, `tab` (`builtin` / `set` / `compare`), `pickedSet` (a set id or `''`) and `compareWith` (Compare's left side, Built-in or a set). Derived: `view` falls back to `builtin` when `pickedSet` names no set; `selected` is what the tab shows (`''` on Built-in, else `pickedSet`, the right side in Compare); `left` falls back to Built-in when `compareWith` was deleted or equals `pickedSet`. `WordingPicker` is the in-app list (same markup and classes as the custom-prompts picker); the top one lists only sets plus **+ New set** / **Import a set…** (`exclude` = Built-in), the Compare card reuses it for **Compare against** (`exclude` = `pickedSet`, no New / Import). `panel` (`new` / `import`) hides the tabs and replaces the card with a form. The selection rules are pure helpers: `initialSelection` on load and discard, `selectionAfterDelete` on delete, and `newSetTools` for the New form's source (`''` Built-in snapshot, `'empty'`, or a set id). Every entry card has **Copy to new set** (Built-in) or **Duplicate** (a set), both `openNew(selected)`.
- **Three tabs, one set list.** The tabs are Built-in, the picked set and Compare; sets are chosen in the list, never one tab per set. The tabs use the segmented look (accent fill on the active tab) so the current view is obvious.
- **Rows.** `ToolRow` renders in `builtin`, `set` or `compare` mode. Each row's `open` state lives on the page, so a remount (revert, remove, discard) keeps the row open.
- **Editing.** `SetDescription` keeps only a local `editing` flag, so **Start blank** can open a box that is not yet a change.
- **Data and saving.** It reads `GET /api/tools/list?projectDir=` (built-in wording, never overridden) and `/api/settings/resolved`. Save sends one PUT, and `renameProblems` keeps Save off while a rename breaks the rules. `beforeunload` and the page's own links warn while changes are unsaved.

### Tests

- `scripts/test-tool-overrides.js` — normalization, prune, copy-not-mutate apply, restore, legacy vs active-set resolution, `ai-stream` wiring.
- `scripts/test-tool-overrides-ui.mjs` — the page's helpers (sets, snapshot, selection after load/delete, what a new set copies, change summary, import/export round trip), route/App/link wiring. It checks behaviour, not where controls sit.
- `scripts/test-routes.js` pins the route.
