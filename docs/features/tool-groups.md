# Tool groups

## Overview

Tool groups decide which tool belongs to which group in every tool list the app renders. One list, `frontend/src/toolGroups.js`, drives the chat Tools card, the composer tools popup, project settings, the Custom prompts preset tree, and the agent editor. Moving a tool between groups is a one-line edit in that file — no surface keeps its own copy of the mapping.

## Usage

Nothing to configure: the grouping is a property of the app, not a per-project setting. What you see is what `toolGroups.js` declares.

### The groups

| Group | Tools | Notes |
| --- | --- | --- |
| **Shell** | `shell` | One tool, one gate. |
| **Subagent** | `subagent` | |
| **Web preview** | `webpreview` | |
| **Chats** | `list_chats`, `get_chat`, `create_chat`, `update_chat`, `change_working_folder`, `search_models`, `start_chat`, `delete_chat`, `search_chats`, `attach_chat_image`, `list_chat_attachments`, `ask_user`, `task`, `report_progress`, `webpreview` | A family, like File tools: the row edits `tools.chats`; a leaf can persist its own more-specific override. It lists everything the model can do with a chat — reading and writing them, and the four tools it uses *inside* one: `ask_user` (pause and ask), `task` (track the work), `report_progress` (report on it) and `webpreview` (show the user a page). `ask_user` stays binary (Off / Ask) and is declared in the family's `binaryTools`, so its leaf row shows the two-way segment while the family row keeps all three. |
| **mouaif** | `get_settings`, `update_settings`, `list_projects`, `get_app_info`, `restart_app`, `list_features`, `group_cli` | A family: the row edits `tools.mouaif`, same rules. It lists every tool that acts on mouaif itself — reading and writing settings, the app restart, the feature report, and the grouped CLI batch tool. |
| **File tools** | `read_file`, `list_files`, `search_files`, `write_file`, `edit_file`, `group_read`, `group_edit` | The row edits `tools.file`; a leaf checkbox can persist its own more-specific override. |

MCP servers are not in this list — their rows come from the server registry, one row per configured server.

### Families

Every group with an Off / Ask / Allow control is a **family**: one gate key under `tools.<key>` in the project (or app, or chat) settings. A single-tool family's key is the tool name. A multi-tool family (**File tools** → `file`, **Chats** → `chats`, **mouaif** → `mouaif`) has one key for all of its leaves, and each leaf may also carry its own entry:

```json
{
  "tools": {
    "chats": { "mode": "allow" },
    "delete_chat": { "mode": "off" }
  }
}
```

The same precedence applies to every multi-tool family: a leaf `off` always wins, a family `allow` beats any other leaf value, otherwise the leaf entry wins over the family. A family `off` hides every leaf from the model.

### Working with the tree

Group rows carry a checkbox that flips every child at once (showing a half-check when only some children are on) and, in project settings and the chat, an Off / Ask / Allow segment that edits the family gate. In project settings each leaf of a multi-tool family also has its own segment for a per-leaf override. See [Tool tree](tool-tree.md) for the full row anatomy.

### What a family `allow` covers

Because `restart_app`, `list_features` and `group_cli` are `mouaif` leaves, a family `allow` — including one earned by choosing **Always allow** on any mouaif call — also lets the assistant restart the app and run a batch of shell commands without asking. Turn either off on its own with a `tools.restart_app` / `tools.group_cli` leaf override if you want the family open and that tool gated. `list_features` is read-only metadata: it is never shown an approval card, but an `off` on the family or on the leaf hides it from the model. `group_cli` is the opposite — it runs commands, so it uses the ordinary approval card.

The Chats family behaves the same way, with one deliberate exception: `ask_user` is a binary tool. A `tools.chats` `allow` covers every chat function including `task`, `report_progress` and `webpreview`, but it can never auto-answer a question — an `ask_user` call always reaches the user, whatever the family or the leaf says. Only `off` (`tools.chats.mode`, or a `tools.ask_user` leaf override) hides it. `report_progress` is read-only UI metadata: it is answered without an approval card too, but an `off` on the family or the leaf still hides it from the model. `webpreview` keeps its own approval card — a family `allow` (or an `Always allow` earned on any Chats call) lets the assistant capture a page without asking.

## Testing

```bash
node scripts/test-tool-groups.mjs          # the model + the generated mirror
node scripts/test-tool-authorization.js       # family gates on the server
node scripts/test-mouaif-tool-categories.mjs
node scripts/test-mouaif-tool-toggle.mjs
node scripts/test-project-settings-render.mjs
```

## See also

- [Tool tree](tool-tree.md) — the rendered hierarchy and row anatomy.
- [Tool authorization](tool-authorization.md) — Off / Ask / Allow and the layers it resolves through.
- [Native chat and app tools](mouaif-tool.md) — the functions inside the Chats and mouaif families.
