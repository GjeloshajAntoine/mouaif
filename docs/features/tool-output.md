# Tool output profile

## Overview

A per-project setting that controls how much of a tool result is fed back to the model, and how that result is laid out. It mirrors the `promptSize` profile (default `average`), lives under the `toolOutput` key in `<projectDir>/.mouaif.json`, and is edited from **Settings → Project → Tools → File tool options**.

## Usage

Open a project (from its card or **Settings → Active project**), go to the **Tools** section, and tap **File tool options**. The page offers two structured controls plus a live JSON readout of the stored value:

- **Output size** — the model-facing byte budget, scaled against the configured base cap (`toolFeedbackMaxBytes`, default 64 KiB):
  - `very-small` — a quarter of the cap: head/tail only.
  - `average` — the cap itself (default).
  - `full` — up to four times the cap.
  - `extensive` — never truncate (the complete result is sent even when it exceeds the cap).
- **Output structure** — how the result body is laid out before the size cap applies:
  - `full` — keep the raw body (default; whitespace/indentation preserved).
  - `concise` — re-serialize JSON to its single-line minified form, or collapse blank runs / leading whitespace in plain text, so the same content costs fewer tokens.

Saving writes the whole `toolOutput` object to the project file, so changing one control keeps the other:

```json
{
  "toolOutput": { "size": "average", "structure": "full" }
}
```

The page reads the **resolved** value (defaults → app → project), so an empty project still shows the default and a project override shows through. Leaving a control at its inherited value does not write that key.

The profile applies to every model-facing tool result: the live multi-turn tool loop and the reconstructed history fed to the model when a chat resumes. `concise` never alters the stored transcript or the SSE events — it only shapes the `role: "tool"` message sent upstream, the same boundary as the existing byte-cap compaction.

## Implementation notes

- The default floor lives in [src/settings.js](../../src/settings.js) `DEFAULTS.toolOutput` (`{ size: 'average', structure: 'full' }`), so every resolved project has a value.
- The semantics live in [src/toolFeedback.js](../../src/toolFeedback.js): `SIZE_MULTIPLIER` maps each size to a byte-budget multiplier against the base `toolFeedbackMaxBytes` cap, `resolveToolOutput` normalizes an arbitrary store value to `{ size, structure }`, and `conciseLayout` produces the compact body. `size` applies as a cap on the compacted body; `extensive` (`Infinity`) bypasses truncation entirely.
- No new HTTP endpoint: the page reuses `GET /api/settings/resolved` for the current value and `PUT /api/settings/project` to persist.
- The UI is a `page: 'output'` mode of `SettingsProjectView` ([frontend/src/components/SettingsProject.jsx](../../frontend/src/components/SettingsProject.jsx)), a sibling of the `technical` page. Routing is `#/settings/project/output` (see [frontend/src/router.js](../../frontend/src/router.js) and the `settingsProjectOutput` dispatch in [frontend/src/components/App.jsx](../../frontend/src/components/App.jsx)).
- The **File tool options** link sits directly under the Tools tree on the project settings page.

## Related

- [Native file tools](./file-tools.md)
- [App and project settings](./app-and-project-settings.md)
- [Tool feedback compaction](./tool-feedback-compaction.md)