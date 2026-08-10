# Tool popup

## Overview

A floating popover opened from a button in the chat composer toolbar that lets the user inspect and change which tools are available to the model, their authorization modes (Off/Ask/Allow), and toggle MCP servers and agent files — all without leaving the chat view.

## Usage

1. Tap the globe icon (🌐) in the composer toolbar, left of the textarea.
2. The popup appears above the composer showing the same hierarchical tool tree that is also rendered in the chat transcript's Tools card.
3. Each tool group can be expanded/collapsed with the chevron; each tool has a checkbox to toggle it on/off for the current chat.
4. For built-in tool groups (shell, subagent, ask_user, task, progress updates, file tools), an Off/Ask/Allow segment control is shown inline.
5. MCP servers appear as their own group; the parent checkbox flips all that server's tools in the per-chat filter at once (the server itself is always on). MCP authorization renders exactly like the chat Tools card and project settings: an **MCP default** row edits the project's shared gate, and each server row carries an Off/Ask/Allow segment for that server's override (with a ↺ reset when an override is set).
6. Agent files found at the project root appear under the tool list as an always-expanded group; every discovered file is shown with its own checkbox. Toggling any agent-file checkbox applies the chat-level **Use agent files** state to all discovered files.
7. Skills found in `.agents/skills/*/SKILL.md` appear below agent files as an always-expanded group with a checkbox next to each skill. Toggling any available skill checkbox applies the chat-level Skills on/off state to the next turn.
8. Tools that have been called in the current chat session show a dot badge (●).
9. Changes are persisted immediately — there is no "Save" button. Saving authorization from the popup updates the transcript's Tools card in place and vice versa, because both surfaces read the same `toolAuth` / `mcpAuth` chat state and a save re-renders both.

## Implementation notes

The chat keeps tool catalogs, MCP servers, agent files, skills, and authorization data in refs because the transcript renderer also consumes them imperatively. After the initial chat load populates those refs, a lightweight render stamp refreshes the popup props so opening it cannot show a stale “No tools available” state.

- **File:** `frontend/src/components/chat/ToolPopup.jsx` — Preact component with two states (closed trigger button, open popup).
- **CSS:** `frontend/src/chat-composer.css` (`.tool-popup*` classes under the *Tool popup* section).
- Reuses the existing `ToolTree` Preact component from `frontend/src/components/ToolTree.jsx` and the `buildToolGroups` helper.
- Auth segments reuse the same `.seg` / `.seg__item` / `.seg__pill` classes from `frontend/src/settings.css`, with compact overrides scoped under `.tool-popup`.
- Outside-click and Escape-key close the popup.
- **Positioning:** the dialog opens *downward* from the trigger (`top: calc(100% + 4px)`), because the trigger sits in the chat head row near the top of the viewport — matching the model picker and chat switcher popovers in the same row. It is capped at `92vw` wide and `60dvh` tall with a scrollable body.
- **Mobile (< 480 px):** the dialog stays a compact popover instead of expanding into a full-screen sheet. Its width is capped to the viewport, and its scrollable height is capped to the measured space between the trigger's bottom and the visual viewport bottom so it cannot overflow downward past the composer and tab bar. The layout-neutral wrapper avoids pointer-event coupling between sizing and interactive controls.