# Tool output profile

## Overview

A per-project setting controls how much of each tool result is fed back to the model and how that result is laid out. It lives under the `toolOutput` key in `<projectDir>/.mouaif.json`, defaults to `{ "size": "average", "structure": "full" }`, and is edited from **Settings → Project → Tools → File tool options**.

## Usage

Open a project, go to **Tools**, and tap **File tool options**. The page exposes the same two dimensions the backend accepts:

- **Size cap** — how much of the model-facing result can be sent:
  - `very-small` — one quarter of `toolFeedbackMaxBytes`.
  - `average` — exactly `toolFeedbackMaxBytes` (default 64 KiB).
  - `full` — four times `toolFeedbackMaxBytes`.
  - `extensive` — never truncate.
- **Layout** — how the body is shaped before the size cap:
  - `full` — preserve the raw model-facing body.
  - `concise` — minify JSON when possible, otherwise collapse blank runs and strip leading indentation/trailing whitespace.

Saving writes the whole `toolOutput` object to the project file:

```json
{
  "toolOutput": { "size": "average", "structure": "full" }
}
```

The page reads the **resolved** value (defaults → app → project), so an empty project still shows the default. Hand-edited `.mouaif.json` values that use any supported backend size/layout pair remain visible in the UI; invalid values are normalized to the default pair.

Below the stored-value readout, an **Example** block shows what the model would receive for a representative **file-tool** result under the selected pair. The sample is a generic `list_files` payload in its compact model-facing form — the same successful file-tool shape [src/tools/files.js](../../src/tools/files.js) emits: a small `#` header, then each directory printed once as a `# <dir>/` group header with bare basenames under it, and no raw JSON envelope. The sample is intentionally larger than every finite cap, so `very-small`, `average`, and `full` show the same head/tail truncation marker the real model path uses, while `extensive` shows the untruncated body.

The profile applies to every model-facing tool result: the live multi-turn tool loop and the reconstructed history fed to the model when a chat resumes. `concise` never alters the stored transcript or SSE events — it only shapes the `role: "tool"` message sent upstream, at the same boundary as the existing byte-cap compaction.

## Related

- [Native file tools](./file-tools.md)
- [App and project settings](./app-and-project-settings.md)
- [Tool feedback compaction](./tool-feedback-compaction.md)
