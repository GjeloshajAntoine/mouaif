# Tool popup

## Overview

A floating popover opened from a button in the chat composer toolbar that lets the user inspect and change which tools are available to the model, their authorization modes (Off/Ask/Allow), and toggle MCP servers and agent files — all without leaving the chat view.

## Usage

1. Tap the globe icon (🌐) in the composer toolbar, left of the textarea.
2. The popup appears above the composer showing the same hierarchical tool tree that is also rendered in the chat transcript's Tools card.
3. Each tool group can be expanded/collapsed with the chevron; each tool has a checkbox to toggle it on/off for the current chat.
4. For built-in tool groups (shell, subagent, ask_user, task, progress updates, file tools), an Off/Ask/Allow segment control is shown inline.
5. MCP servers appear as their own group; the parent checkbox enables/disables the server itself. MCP authorization renders exactly like the chat Tools card and project settings: an **MCP default** row edits the project's shared gate, and each server row carries an Off/Ask/Allow segment for that server's override (with a ↺ reset when an override is set).
6. Agent files found at the project root appear as a group with a single toggle.
7. Tools that have been called in the current chat session show a dot badge (●).
8. Changes are persisted immediately — there is no "Save" button. Saving authorization from the popup updates the transcript's Tools card in place and vice versa, because both surfaces read the same `toolAuth` / `mcpAuth` chat state and a save re-renders both.

## Implementation notes

- **File:** `src/web/src/components/chat/ToolPopup.jsx` — Preact component with two states (closed trigger button, open popup).
- **CSS:** `src/web/src/chat-composer.css` (`.tool-popup*` classes under the *Tool popup* section).
- Reuses the existing `ToolTree` Preact component from `src/web/src/components/ToolTree.jsx` and the `buildToolGroups` helper.
- Auth segments reuse the same `.seg` / `.seg__item` / `.seg__pill` classes from `src/web/src/settings.css`, with compact overrides scoped under `.tool-popup`.
- Outside-click and Escape-key close the popup.
- **Positioning:** the dialog opens *upward* from the trigger (`bottom: calc(100% + 6px)`), because the trigger sits in the chat head row, directly above the status bar — opening downward would clip the dialog into the status bar. It is capped at `92vw` wide and `60dvh` tall with a scrollable body.
- **Mobile (< 480 px):** the dialog stays a compact upward-opening popover instead of expanding into a full-screen sheet. Its width is capped to the viewport, and its scrollable height is capped to the measured space between the trigger and the visual viewport top so it cannot overflow upward. The layout-neutral wrapper avoids pointer-event coupling between sizing and interactive controls.