# Tool output profile

## Overview

A per-project setting that controls how much of a tool result is fed back to the model, and how that result is laid out. It mirrors the `promptSize` profile (default `average`), lives under the `toolOutput` key in `<projectDir>/.mouaif.json`, and is edited from **Settings → Project → Tools → File tool options**.

## Usage

Open a project (from its card or **Settings → Active project**), go to the **Tools** section, and tap **File tool options**. The page offers two structured controls plus a live JSON readout of the stored value:

- **Output size** — how much of a result the model sees:
  - `very-small` — head/tail only.
  - `average` — most of the result (default).
  - `full` — the complete result.
  - `extensive` — full result plus surrounding context.
- **Output structure** — reserved for how the result body is arranged; only the built-in `full` shape ships today. Kept as a select so the shape is stable for future values.

Saving writes the whole `toolOutput` object to the project file, so changing one control keeps the other:

```json
{
  "toolOutput": { "size": "average", "structure": "full" }
}
```

The page reads the **resolved** value (defaults → app → project), so an empty project still shows the default and a project override shows through. Leaving a control at its inherited value does not write that key.

## Implementation notes

- The default floor lives in [src/settings.js](../../src/settings.js) `DEFAULTS.toolOutput` (`{ size: 'average', structure: 'full' }`), so every resolved project has a value.
- No new HTTP endpoint: the page reuses `GET /api/settings/resolved` for the current value and `PUT /api/settings/project` to persist.
- The UI is a `page: 'output'` mode of `SettingsProjectView` ([frontend/src/components/SettingsProject.jsx](../../frontend/src/components/SettingsProject.jsx)), a sibling of the `technical` page. Routing is `#/settings/project/output` (see [frontend/src/router.js](../../frontend/src/router.js) and the `settingsProjectOutput` dispatch in [frontend/src/components/App.jsx](../../frontend/src/components/App.jsx)).
- The **File tool options** link sits directly under the Tools tree on the project settings page.

## Related

- [Native file tools](./file-tools.md)
- [App and project settings](./app-and-project-settings.md)
- [Tool feedback compaction](./tool-feedback-compaction.md)