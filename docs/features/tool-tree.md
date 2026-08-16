# Tool Tree

## Overview

The tool tree is a compact, hierarchical list that shows every tool the model can use, with checkboxes for visibility and inline authorization controls. It replaces the old stacked permissions UI and chip toggles with a single thin tree that is the same in the chat view, the composer's tool popup, and project settings.

## Usage

### Chat view

The tree sits below the system prompt. It shows one group per tool family:

- **shell** — run terminal commands
- **subagent** — delegate a task to a nested AI call
- **ask_user** — pause and ask the user a structured question
- **File tools** — read_file, list_files, search_files, write_file, edit_file
- **One group per MCP server** — configured servers always render, even when stopped; stopped servers fall back to the cached tool list from their last run. The group checkbox flips all the server's tools in the per-chat tool filter at once (there is no server-level on/off); leaf checkboxes flip individual tools.

Each group row has:

- a **checkbox** that toggles every child tool at once — it shows a **half-check (indeterminate)** state when some but not all of the group's child tools are on, so a partial selection is visible at a glance
- the group name
- a short one-line description (truncated, with a tooltip for the full text)
- a **collapse chevron** (only when there is more than one child)
- a **count badge** (`3/5`) when partially checked
- an **authorization segment** (`Off / Ask / Allow`) — every group carries one, MCP included: each MCP server row edits that server's override (`mcp.servers.<slug>`) while showing the *effective* mode. The compact tree does not show a separate override-reset button.

Leaf rows are individual tools. Only the checkbox is clickable — the row text is inert, so tapping a name never toggles anything accidentally. Tools that have been called in the current chat show a blue dot (`●`) and are automatically checked ("started when used").

### Project settings

Settings → Project shows the same tree, with each group row carrying its **authorization segment** on the same line: `Off / Ask / Allow` (or `Off / Ask` for binary tools like `ask_user`). The group checkbox is a shortcut for `Off ↔ Ask`; the segment is the only way to pick `Allow`. MCP renders exactly like the chat view: one expandable row per configured MCP server. Each discovered MCP tool is a child checkbox, backed by `mcp.tools.<composedName>` React state: unchecking creates an `off` override and checking clears that override so the tool inherits its server/default mode. The leaf label omits the repeated `mcp__<server>__` prefix while retaining the composed name as its stable ID. The server checkbox remains the server override's `Off ↔ Ask` shortcut, and the segment edits the per-server override. The row description states whether the mode is an override or inherited (`override: ask` / `default (ask)`). Auto-approve patterns (the `allowlist` mode) are still honored when present in the project file, but the settings tree no longer renders a textarea for them — edit them from the raw `.mouaif.json` / `.mcp.json` in Technical details.

The settings tree replaces the old "Tool permissions" list — the UI is identical to the chat view so the mental model is the same: one tree, one place to look. Like the chat tree, groups with more than one nested tool start collapsed. The `ToolTree` holds its own collapse state, so a group the user expands stays open across SettingsProject re-renders (a checkbox or segment change only re-renders the tree in place). Because MCP server groups load asynchronously behind the native groups, `ToolTree` seeds any collapsible group that appears *after* its initial collapse set is built — so a late-arriving server group starts collapsed too — while an explicitly expanded group is preserved (the `flip` handler marks it `touched`, so the seed loop skips it).

File tools inherit from the `tools.file` family gate. A leaf checkbox can persist a more-specific `tools.<tool_name>` `off` override, which disables one operation without changing its siblings; stale per-file `ask` entries do not tighten a family-level `allow`. The parent checkbox updates the family and all visible leaves together, so it settles directly on checked or unchecked rather than briefly becoming indeterminate. The authorization segment edits the shared family default while preserving explicit `off` leaf overrides.
