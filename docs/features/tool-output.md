# Tool output profile

## Overview

A per-project setting that controls how much of a tool result is fed back to the model, and how that result is laid out. It mirrors the `promptSize` profile (default `average`), lives under the `toolOutput` key in `<projectDir>/.mouaif.json`, and is edited from **Settings → Project → Tools → File tool options**.

## Usage

Open a project (from its card or **Settings → Active project**), go to the **Tools** section, and tap **File tool options**. The page offers a single **Output profile** control plus a live JSON readout of the stored value. Each profile maps to a `{ size, structure }` combo:

- **Small** — `very-small` size (a quarter of the cap: head/tail only) + `concise` layout (minified JSON, collapsed blank runs), for the tightest context.
- **Balanced** — `average` size (the standard `toolFeedbackMaxBytes` cap, default 64 KiB) + `full` layout (raw body). This is the default.
- **Full** — `extensive` size (never truncate) + `full` layout, so the complete raw result is always sent.

Saving writes the whole `toolOutput` object to the project file:

```json
{
  "toolOutput": { "size": "average", "structure": "full" }
}
```

The page reads the **resolved** value (defaults → app → project), so an empty project still shows the default (**Balanced**) and a project override shows through. A hand-edited `.mouaif.json` whose `{ size, structure }` pair matches none of the three profiles is shown as **Balanced** until the user picks a profile, which then rewrites the stored combo.

Below the stored-value readout, an **Example** block shows what the model would receive for a representative **file-tool** result under the selected profile. The sample is an actual `list_files` payload in its compact model-facing form — the same shape [src/tools/files.js](../../src/tools/files.js) emits: a small `#` header, the directory printed once as a group header, bare basenames under it, and no raw JSON envelope. It then runs the *real* transform from [src/toolFeedback.js](../../src/toolFeedback.js): **Balanced** and **Full** pass the body through, while **Small** applies the `concise` layout — blank runs collapsed, leading indentation and trailing whitespace stripped. Because the sample is well under every size cap, no truncation marker fires; the head/tail marker only appears once a result exceeds the profile's byte budget. The sample text is fixed; the transform shown is not faked.

The profile applies to every model-facing tool result: the live multi-turn tool loop and the reconstructed history fed to the model when a chat resumes. `concise` never alters the stored transcript or the SSE events — it only shapes the `role: "tool"` message sent upstream, the same boundary as the existing byte-cap compaction.

## Implementation notes

- The default floor lives in [src/settings.js](../../src/settings.js) `DEFAULTS.toolOutput` (`{ size: 'average', structure: 'full' }`), so every resolved project has a value.
- The semantics live in [src/toolFeedback.js](../../src/toolFeedback.js): `SIZE_MULTIPLIER` maps each size to a byte-budget multiplier against the base `toolFeedbackMaxBytes` cap, `resolveToolOutput` normalizes an arbitrary store value to `{ size, structure }`, and `conciseLayout` produces the compact body. `size` applies as a cap on the compacted body; `extensive` (`Infinity`) bypasses truncation entirely.
- No new HTTP endpoint: the page reuses `GET /api/settings/resolved` for the current value and `PUT /api/settings/project` to persist.
- The UI is a `page: 'output'` mode of `SettingsProjectView` ([frontend/src/components/SettingsProject.jsx](../../frontend/src/components/SettingsProject.jsx)), a sibling of the `technical` page. One `<select>` drives the three profiles; an `OUTPUT_PROFILES` map in the component defines the `{ size, structure }` combo each profile stores. Routing is `#/settings/project/output` (see [frontend/src/router.js](../../frontend/src/router.js) and the `settingsProjectOutput` dispatch in [frontend/src/components/App.jsx](../../frontend/src/components/App.jsx)).
- The **File tool options** link sits directly under the Tools tree on the project settings page.

## Related

- [Native file tools](./file-tools.md)
- [App and project settings](./app-and-project-settings.md)
- [Tool feedback compaction](./tool-feedback-compaction.md)