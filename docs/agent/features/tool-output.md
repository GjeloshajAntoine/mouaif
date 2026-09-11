# Tool output profile — implementation notes

> Agent-facing reference for [`docs/features/tool-output.md`](../../features/tool-output.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- The default floor lives in [src/settings.js](../../src/settings.js) `DEFAULTS.toolOutput` (`{ size: 'average', structure: 'full' }`), so every resolved project has a value.
- The semantics live in [src/toolFeedback.js](../../src/toolFeedback.js): `SIZE_MULTIPLIER` maps each size to a byte-budget multiplier against the base `toolFeedbackMaxBytes` cap, `resolveToolOutput` normalizes arbitrary stored values to `{ size, structure }`, and `conciseLayout` produces the compact body. `size` applies as a cap on the compacted body; `extensive` (`Infinity`) bypasses truncation entirely.
- No new HTTP endpoint: the page reuses `GET /api/settings/resolved` for the current value and `PUT /api/settings/project` to persist.
- The UI is a `page: 'output'` mode of `SettingsProjectView` ([frontend/src/components/SettingsProject.jsx](../../frontend/src/components/SettingsProject.jsx)), a sibling of the `technical` page. Separate **Size cap** and **Layout** `<select>` controls write the same `toolOutput` object used by the backend. Routing is `#/settings/project/output` (see the table in [frontend/src/routes.js](../../frontend/src/routes.js) and the `settingsProjectOutput` dispatch in [frontend/src/components/App.jsx](../../frontend/src/components/App.jsx)).
- The **File tool options** link sits directly under the Tools tree on the project settings page.
- The **Example** block is rendered by `exampleFor(size, structure)` in the same component file. It builds the sample listing from a compact cross-product — hand-written spine directories plus `moduleStems × domainPrefixes × variants × concerns` — so ~40 lines of source expand into ~900 directories / ~5.4k files (~92 KiB raw), which clears every finite cap without hard-coding thousands of paths. The generator then replays the backend order (structure → byte cap → 75/25 head-tail truncation with the standard marker) against the same `SIZE_MULTIPLIER` / `toolFeedbackMaxBytes` constants, so the preview matches `src/toolFeedback.js` without importing it.
