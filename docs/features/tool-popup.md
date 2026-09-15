# Tool popup

## Overview
A floating popover opened from the chat view top bar lets the user inspect and change which tools are available to the model, their authorization modes (Off/Ask/Allow), and toggle MCP servers and agent files — all without leaving the chat view. The mobile-first popover opens below the complete chat header, remains within the visual viewport, and scrolls its tool list independently.
## Usage
1. Tap the globe icon (🌐) in the chat view top bar.
2. The popup appears below the header showing the same hierarchical tool tree that is also rendered in the chat transcript's Tools card. *Custom actions are no longer listed here* — they moved to the **file toolbar** dropdown menu (see [custom-actions.md](custom-actions.md)).
3. Each tool group can be expanded/collapsed with the chevron; each tool has a checkbox to toggle it on/off for the current chat.
4. For built-in tool groups (shell, subagent, ask_user, task, progress updates, file tools), an Off/Ask/Allow segment control is shown inline. **These segments are chat-scoped**: a tap pins the mode for THIS chat only (stored on the chat record) and never rewrites the project's `.mouaif.json`. Project-wide modes are edited in Settings → Project. The popup footer says so.
5. MCP servers appear as their own group; the parent checkbox flips all that server's tools in the per-chat filter at once (the server itself is always on). MCP authorization renders exactly like the chat Tools card and project settings: each server row carries an Off/Ask/Allow segment for that server's override — again chat-scoped, layered over the project's `.mcp.json` value. No separate override-reset button is shown in the compact popup; the chat surfaces drop this chat's own entry before writing the tapped mode, so the project value always remains the fallback.
6. A stopped-but-enabled MCP server also shows a **…** control on its row. Tapping it starts that server on demand (the same action the transcript Tools card exposes), so the server's live tools appear without waiting for the next tool call. While the server is starting, the control pulses and is disabled; the row flips to its live state when the tools are discovered. A server whose authorization is **Off** never shows the control — it is not startable.
7. Agent files found at the project root appear under the tool list as an always-expanded group; every discovered file is shown with its own checkbox. Toggling any agent-file checkbox applies the chat-level **Use agent files** state to all discovered files.
8. Skills found in `.agents/skills/*/SKILL.md` appear below agent files as an always-expanded group with a checkbox next to each skill. Each skill row toggles that one skill for the current chat (stored on the chat's `disabledSkills` list, siblings untouched); the group checkbox is the all-on / all-off shortcut for the chat.
9. Tools that have been called in the current chat session show a dot badge (●).
10. Changes are persisted immediately — there is no "Save" button. Saving authorization from the popup updates the transcript's Tools card in place and vice versa, because both surfaces read the same `toolAuth` / `mcpAuth` chat state and a save re-renders both.
11. The Off/Ask/Allow choices here belong to **this chat**. They are saved on the chat record (`chat.toolAuth`, app SQLite store) through `PUT /api/tools/authorization` with `scope: 'chat'` — the project's `.mouaif.json` / `.mcp.json` are never written from a chat. A tool whose mode you change here keeps that mode when you reopen the chat, and the chat's other tools are unaffected. See [tool-authorization.md](tool-authorization.md).

## Implementation notes
The popup is viewport-fixed but anchored from the globe trigger and the full `.chat-view__head` bounds. Its height is capped by the remaining visual viewport, `60dvh`, and `400px`; the tool tree body scrolls while the header, close control, and auto-retry footer remain reachable.

Both tree surfaces render the same `ToolTree` component, so every control it can draw has to be wired on both sides. The MCP start control was not: the popup rendered `ToolTree` without `onReloadServer`, so its **…** button had no handler and tapping it did nothing, while the transcript card's identical button started the server. The start action now lives on the chat state hook (`state._startMcpServer`), which sets the busy marker, calls `POST /api/mcp/servers/:id/start`, refreshes the server list and tool catalog, and re-renders both surfaces. The popup receives it as `onReloadMcpServer` plus the `mcpStartBusy` id, and the transcript card calls the same action instead of inlining its own copy.

The authorization segments are chat-scoped. Both surfaces render the shared `ToolAuthSeg` / `McpAuthSeg`, and both pass an `onClear` that fires before `onPick` / `onSave`: the hook first drops this chat's entry for that tool (`PUT … { scope: 'chat', chat: { native: { shell: null } } }`) and then writes the tapped mode, so the stored override always equals the tap and a stale chat value can never shadow the project's mode. `SettingsProject` passes no `onClear` — its writes go to the project file, where the written value *is* the default.

```jsx
h(ToolTree, {
  groups,
  onToggleGroup: handleToggleGroup,
  onToggleTool: handleToggleTool,
  onReloadServer: handleReloadServer, // without this the "…" control is inert
  collapsedByDefault: true,
  class: 'tool-popup__tree'
})
```
