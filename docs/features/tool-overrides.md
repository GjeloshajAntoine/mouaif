# Tool wording — change what the model is told about a tool

## Overview

Every tool the model can call comes with a description and a list of fields (its parameters). **Tool wording** lets a project re-word both: a custom description for any tool, and a custom name for any of its top-level fields. It is for tuning how a model reads a tool — a shorter description, a field called `command` instead of `cmd` — without changing what the tool does.

Wording is kept in **sets**. **Built-in** is the wording every tool ships with and can't be edited. A project can have up to 20 sets of its own. You create a set as a copy of Built-in, a copy of another set, or empty, then name it, edit it and compare it. Three tabs show Built-in, the set picked in the **Set** list, and a comparison of the two. Each project makes one set, or Built-in, the default for its chats.

The model sees the re-worded tool. The app still runs the original one: when the model calls `shell` with `command`, mouaif maps it back to `cmd` before anything runs, is approved, or is shown on a card.

## Usage

Open **Settings → Project settings**, and under the tool list tap **Tool wording** (`#/settings/project/tool-overrides?projectDir=…`).

### Tabs

The **Set** list at the top holds the project's sets (*No sets yet* until you create one); the default for chats is marked *default*. Under it, three tabs:

- **Built-in** shows each tool's own description and its fields: name, type, whether it is required, and description. Nothing here can be edited.
- **_The picked set_** (the tab is named after it) can be edited: its name, each tool's description, and its field names. Picking a set in the list opens this tab.
- **Compare** diffs the picked set against Built-in or another set (see Comparing).

The set and Compare tabs are greyed out until the project has a set. A green dot marks the tab that is the default for chats.
- **Make default** (a plain button; it only takes effect on Save) makes what the tab shows, Built-in or the set, the default for this project's chats. Once it is, a *default for chats* badge shows instead. After you save, the default applies from the next message of every chat in the project.

### Creating a set

Tap **Copy to new set** on the Built-in card, **Duplicate** on a set's card, **+ New** beside the list, or **+ New set** at the bottom of the list. Give the set a name and choose what it starts from: any entry can be copied. The card button starts on that card's entry; **+ New** starts on what the tab shows.

- **Copy of Built-in**: every tool's current description, copied in full and frozen. When mouaif's built-in wording changes later, the copy keeps its own text, and Compare shows where they drifted.
- **Copy of _a set_**: everything in that set, unsaved edits included.
- **Empty**: nothing yet. Every tool keeps using the built-in wording, and follows built-in updates, until you edit that tool.

The new set is picked, on its tab, as soon as it is created.

### Editing a set

On the set's tab:

- Its name sits at the top of its card; edit it there. Two sets can't share a name; a duplicate gets a number added.
- A count shows how many tools differ from built-in.
- **Duplicate**, **Copy JSON** and **Download** sit in the card, with **Delete set** apart on its own row. After a delete, the list moves to the default set, else the next set; with no set left, the Built-in tab shows.
- Each tool's description box holds the set's text. It grows to fit the text and counts characters against the 4000 limit.
- If the set doesn't include a tool, the row says so and offers **Copy built-in text** or **Start blank**.
- **Reset to built-in** drops the tool's description from the set. **Remove from set** drops its description and its field names.
- To rename a field, type a new name into its box. Leave the box empty to keep the original name.
- Rows that differ from built-in are marked *changed*.

### Comparing

The **Compare** tab diffs the picked set against Built-in. **Compare against** picks another set instead. A line under it names both sides and how many tools differ. Picking the left side's set in the **Set** list swaps the sides.

- The **Compare against** entry is on the left and the picked set on the right.
- Removed words are struck through and added words are highlighted, with a count of words added and removed.
- Each field shows its name on both sides, or *same*.
- Rows that differ are marked *differs*.

**Show only tools that differ** hides the rest, from built-in while editing a set or from the other side while comparing. Search filters tools by name or description.

### Saving

Nothing is saved as you type. Creating, editing, renaming, deleting, importing and choosing the default all change a draft. Each tool you change is marked *unsaved*. A bar at the bottom of the page lists what Save would do (for example, *“Terse”: 2 tools · new set “Verbose” · default: “Terse”*), with **Save** and **Discard**:

- **Save** writes everything at once.
- **Discard** asks first, then goes back to what was last saved.
- **Revert this tool** in a row undoes only that tool's unsaved changes in the set.
- Save stays off while a field name breaks the rules below, and the bar names the set.
- Leaving the page with unsaved changes asks you to confirm.

### Import & export

**Import a set…** at the bottom of the picker opens a box in place of the picked entry's card:

1. Paste a set's JSON, or choose a `.json` file.
2. Optionally give it a name.
3. Tap **Import as new set**. The import always becomes a new set; no existing set is changed.

**Copy JSON** and **Download** export the picked set:

```json
{
  "name": "Terse",
  "tools": {
    "shell": {
      "description": "Run a command",
      "fields": { "cmd": "command" }
    }
  }
}
```

Import also accepts three other shapes:

- a bare `{ "<tool>": { … } }` map
- an older project file (`{ "toolOverrides": { … } }`)
- a list of `{ "name", "description", "fields" }` entries

### Wording saved before sets

A project that had tool wording before sets existed opens with that wording as a set called **Custom**, already the default. It keeps applying exactly as before. The next Save stores it as a set.

## Rules

- Field names use letters, digits, `_` and `-`, start with a letter or `_`, and are at most 64 characters. A name the tool already uses, or one used for another renamed field, is refused (the page says so as you type).
- Descriptions are limited to 4000 characters.
- Only **top-level** fields are renamed. Tool names, permissions, grouping and nested fields are unchanged.
- A tool that is Off, or an MCP server that is not running, is not sent to the model, so its wording is kept but unused. Wording for a tool that is not in the project's list is kept on import.
- A tool a set doesn't include is sent with its built-in wording.
- A direct tool call from the composer is not re-worded.

For the module surface, storage and wiring, see the implementation notes that ship with the repository (`docs/agent/features/tool-overrides.md`).
