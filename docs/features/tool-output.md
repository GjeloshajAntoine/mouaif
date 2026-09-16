# Tool output profile

## Overview

A per-project setting controls how much of each tool result is fed back to the model and how file-listing results are laid out. It lives under the `toolOutput` key in `<projectDir>/.mouaif.json`, defaults to `{ "size": "average", "structure": "tree" }`, and is edited from **Settings → Project → Tools → File tool options**.

## Usage

Open a project, go to **Tools**, and tap **File tool options**. The page exposes a single **Layout** control that picks how the native file-listing tools (`list_files`, `search_files`, and `read_file`) render their result for the model:

- **Hierarchical** (`tree`, the default) — an indented tree: each path segment is a node, directories printed once with a trailing `/`, files nested two spaces deeper. Because every shared path prefix is written once, this is the most compact text layout.
- **Full JSON** (`json`) — the exact structured result serialized as JSON, so the model can parse it programmatically.

The layout only changes how file-listing tools render; generic tool output (shell, MCP) is unaffected.

The other backend dimension, **`size`** (the byte cap), is not surfaced in the UI. It keeps its stored value (default `average`) and can still be hand-edited in `.mouaif.json`:

- `very-small` — one quarter of `toolFeedbackMaxBytes`.
- `average` — exactly `toolFeedbackMaxBytes` (default 64 KiB).
- `full` — four times `toolFeedbackMaxBytes`.
- `extensive` — never truncate.

Saving the Layout writes the whole `toolOutput` object to the project file, preserving the current `size`:

```json
{
  "toolOutput": { "size": "average", "structure": "tree" }
}
```

The page reads the **resolved** value (defaults → app → project), so an empty project still shows the default. Hand-edited `.mouaif.json` values that use either supported layout stay visible in the UI; any other value — including the retired `grouped` layout and the legacy `full` / `concise` generic structures — normalizes to `tree` in the selector, and the tools themselves fall back to `tree` when the stored value is unknown.

Below the stored-value readout, an **Example** block shows what the model would receive for a representative `list_files` result under the selected layout. The sample is a monorepo-shaped file list generated from a small cross-product (module stems × directory prefixes × variants × sub-concerns), so a few lines of source expand into ~900 directories / ~5.4k files (~90 KiB), past every finite cap: `very-small` and `average` show the head/tail truncation marker the real model path uses, while `full` and `extensive` show the untruncated body.

The layout applies to every model-facing file-tool result in the live multi-turn tool loop; the structured `result` surfaced to the chat UI and stored transcript is unchanged — only the `role: "tool"` message sent upstream is reshaped, at the same boundary as the existing byte-cap compaction. When a card is replayed from a stored transcript, the UI parses the indented body back into `entries` / `matches`, so a card's count and summary stay correct — and transcripts written under the retired `# dir/` grouped layout still parse.

## Related

- [Native file tools](./file-tools.md)
- [App and project settings](./app-and-project-settings.md)
- [Tool feedback compaction](./tool-feedback-compaction.md)
