# Simplified tool view

## Overview

A project can show its own short list of tool categories in the chat instead of every tool. You name the categories and pick the tools each one lists — for example **Read** (`read_file`, `search_files`) and **Run** (`shell`) — and the chat's Tools card and the composer's tools popup show those categories in place of the default groups (Shell, Chats, File tools, one per MCP server, …).

It is a display setting only. A tool left out of every category keeps its checkbox state and its Off / Ask / Allow mode, and the model is offered exactly the same tools as before; the tool is simply tucked under the **All (N)** tab in the chat.

## Usage

1. Open **Settings → Project → Tools → Chat tool list** (the row shows **All tools** or **Simplified · K categories (N)**).
2. Choose **Simplified view** in the mode cards (or turn on **Use simplified categories in chats**).
3. Either tap one of the **Quick start with a preset** cards (**Coding essentials**, **Read & inspect**, **Full coding + subagents**) to populate ready-made categories in one tap, or tap **+ Add category** to create your own.
4. Type a category name, then tap **+ Choose tools** (or **Edit tools (N)**) to open the searchable tool picker. Filter tools by name or group and tick the tools the category should display. Picked tools appear as chips showing their group and function name; **×** on a chip removes it.
5. Add more categories as needed. **↑** / **↓** reorder them and **×** removes one. A tool may sit in more than one category.
6. Check the **Coverage summary** and the **Live chat preview** at the bottom of the page to see how many tools are pinned in your simplified categories vs. kept active under **All (N)**.

Every change saves immediately. Open a chat (or reload an open one) to see the result.

### In the chat

When the view is on and at least one category has a tool, the Tools card and the tools popup list your categories:

- A segmented **Simplified (N) | All (M)** pill in the card and popup header shows which view is active and how many tools each view lists. Tap **All (M)** to switch to the full default tree, or **Simplified (N)** to return to your categories.
- When simplified categories hide some catalog tools, a subtle note below the header reminds you (`+K more tools stay active for the AI · Show all M →`) so it is always clear that unpinned tools are still available to the model.
- A category checkbox switches all of its tools on or off for the chat, and shows a half-check when only some are on.
- Each tool row keeps its own checkbox and Off / Ask / Allow segment. Category rows have no segment, because a category can mix tools from different groups.
- Agent files and Skills in the popup are not affected.

A picked tool that is not available (a removed MCP server, a tool the project switched off) is skipped, and a category with no available tool is not shown. With the mode set to **All tools**, or with no tool picked, the chat shows the default tree.

## The stored value

The setting is stored per project as `toolView`:

```json
{
  "toolView": {
    "enabled": true,
    "categories": [
      { "name": "Read", "tools": ["read_file", "search_files"] },
      { "name": "Run", "tools": ["shell", "mcp__git__git_log"] }
    ]
  }
}
```

Tools are named by their function name (MCP tools as `mcp__<server>__<tool>`). Up to 24 categories are kept, and names are cut at 40 characters.

## See also

- [Tool tree](tool-tree.md) — the rows and their controls.
- [Tool groups](tool-groups.md) — the default groups.
