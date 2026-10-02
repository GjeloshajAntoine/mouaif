# Tool groups

## Overview

Tool groups decide which tool belongs to which group in every tool list the app renders. One list, `frontend/src/toolGroups.js`, drives the chat Tools card, the composer tools popup, project settings, the Custom prompts preset tree, and the agent editor. Moving a tool between groups is a one-line edit in that file — no surface keeps its own copy of the mapping.

## Usage

Nothing to configure: the grouping is a property of the app, not a per-project setting. What you see is what `toolGroups.js` declares.

### The groups

| Group | Tools | Notes |
| --- | --- | --- |
| **Chats** | `list_chats`, `get_chat`, `create_chat`, `update_chat`, `delete_chat`, `search_chats`, `attach_chat_image`, `list_chat_attachments` | A category: each function has its own Off / Ask / Allow, and the row's segment writes all of them. |
| **mouaif** | `get_settings`, `update_settings`, `list_projects`, `get_app_info` | The second category, same rules. |
| **Shell** | `shell` | One tool, one gate. |
| **Subagent** | `subagent` | |
| **Task** | `task` | |
| **Ask user** | `ask_user` | Off / Ask only — the model cannot predict the answer. |
| **Web preview** | `webpreview` | |
| **Restart app** | `restart_app` | |
| **Progress updates** | `report_progress` | |
| **File tools** | `read_file`, `list_files`, `search_files`, `write_file`, `edit_file`, `group_read`, `group_edit` | The row edits `tools.file`; a leaf checkbox can persist its own more-specific override. |
| **Feature report** | `list_features` | No Off / Ask / Allow: the server answers this read-only metadata tool without an authorization prompt, so the row says so instead of offering a control that would not do anything. |

MCP servers are not in this list — their rows come from the server registry, one row per configured server.

### Working with the tree

Group rows carry a checkbox that flips every child at once (showing a half-check when only some children are on) and, in project settings and the chat, an Off / Ask / Allow segment. A category row shows a mode only when every child agrees, otherwise Ask. See [Tool tree](tool-tree.md) for the full row anatomy.

## Testing

```bash
node scripts/test-tool-groups.mjs          # the model + the generated mirror
node scripts/test-mouaif-tool-categories.mjs
node scripts/test-mouaif-tool-toggle.mjs
node scripts/test-project-settings-render.mjs
```

## See also

- [Tool tree](tool-tree.md) — the rendered hierarchy and row anatomy.
- [Tool authorization](tool-authorization.md) — Off / Ask / Allow and the layers it resolves through.
- [Native chat and app tools](mouaif-tool.md) — the functions inside the two category rows.
