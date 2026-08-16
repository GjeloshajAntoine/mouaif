# Tool popup

## Overview

A floating popover opened from a button in the chat composer toolbar that lets the user inspect and change which tools are available to the model, their authorization modes (Off/Ask/Allow), and toggle MCP servers and agent files — all without leaving the chat view.

## Usage

1. Tap the globe icon (🌐) in the composer toolbar, left of the textarea.
2. The popup appears above the composer showing the same hierarchical tool tree that is also rendered in the chat transcript's Tools card.
3. Each tool group can be expanded/collapsed with the chevron; each tool has a checkbox to toggle it on/off for the current chat.
4. For built-in tool groups (shell, subagent, ask_user, task, progress updates, file tools), an Off/Ask/Allow segment control is shown inline.
5. MCP servers appear as their own group; the parent checkbox flips all that server's tools in the per-chat filter at once (the server itself is always on). MCP authorization renders exactly like the chat Tools card and project settings: each server row carries an Off/Ask/Allow segment for that server's override. No separate override-reset button is shown in the compact popup.
6. Agent files found at the project root appear under the tool list as an always-expanded group; every discovered file is shown with its own checkbox. Toggling any agent-file checkbox applies the chat-level **Use agent files** state to all discovered files.
7. Skills found in `.agents/skills/*/SKILL.md` appear below agent files as an always-expanded group with a checkbox next to each skill. Toggling any available skill checkbox applies the chat-level Skills on/off state to the next turn.
8. Tools that have been called in the current chat session show a dot badge (●).
9. Changes are persisted immediately — there is no "Save" button. Saving authorization from the popup updates the transcript's Tools card in place and vice versa, because both surfaces read the same `toolAuth` / `mcpAuth` chat state and a save re-renders both.
