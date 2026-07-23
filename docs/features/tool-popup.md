# Tool popup

## Overview

A floating popover opened from a button in the chat composer toolbar that lets the user inspect and change which tools are available to the model, their authorization modes (Off/Ask/Allow), and toggle MCP servers and agent files — all without leaving the chat view.

## Usage

1. Tap the globe icon (🌐) in the composer toolbar, left of the textarea.
2. The popup appears above the composer showing the same hierarchical tool tree that is also rendered in the chat transcript's Tools card.
3. Each tool group can be expanded/collapsed with the chevron; each tool has a checkbox to toggle it on/off for the current chat.
4. For built-in tool groups (shell, subagent, ask_user, file tools), an Off/Ask/Allow segment control is shown inline.
5. MCP servers appear as their own group; the parent checkbox enables/disables the server itself.
6. Agent files found at the project root appear as a group with a single toggle.
7. Tools that have been called in the current chat session show a dot badge (●).
8. Changes are persisted immediately — there is no "Save" button.

## Implementation notes

- **File:** `src/web/src/components/chat/ToolPopup.jsx` — Preact component with two states (closed trigger button, open popup).
- **CSS:** `src/web/src/chat.css` (`.tool-popup*` classes at the end).
- Reuses the existing `ToolTree` Preact component from `src/web/src/components/ToolTree.jsx` and the `buildToolGroups` helper.
- Auth segments reuse the same `.seg` / `.seg__item` / `.seg__pill` classes from `src/web/src/settings.css`, with compact overrides scoped under `.tool-popup`.
- Outside-click and Escape-key close the popup.
- Positioned above the composer (`bottom: calc(100% + 8px)`), capped at `92vw` wide and `60dvh` tall with a scrollable body.