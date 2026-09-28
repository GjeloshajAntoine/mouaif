# Read tools and Edit tools

## Overview

The five native file operations render in the tool tree as **two** groups instead of one: **Read tools** (`read_file`, `list_files`, `search_files`) and **Edit tools** (`write_file`, `edit_file`). The split is by **effect** — the read half only inspects the project, the edit half changes files on disk — so read-only access is one gesture instead of four.

## Usage

### Where it shows up

The same two groups appear everywhere the tool tree is rendered, so a tool looks the same on every surface:

- the chat transcript's tools card (below the system prompt),
- the composer's tool popup (globe icon in the chat top bar),
- the Custom prompts **Chat preset** tool tree,
- **Settings → Project → Tools**,
- the agent editor's **Tools** allowlist.

### Reading the rows

Each of the two rows carries the same controls any other group has:

- a **checkbox** that toggles that group's leaves,
- a short description (`read, list, search` / `write, edit`),
- a **half-check** when only some of the group's leaves are on,
- an **authorization segment** (`Off / Ask / Allow`).

In the chat surfaces, the group checkbox toggles that group's tools in the per-chat `tools` filter — unchecking **Read tools** hides `read_file`, `list_files`, and `search_files` from the model for this chat while **Edit tools** stays on.

In **Settings → Project**, the group checkbox writes **per-leaf overrides** so the two rows stay independent:

- the **Read tools** checkbox sets `tools.read_file`, `tools.list_files`, and `tools.search_files`,
- the **Edit tools** checkbox sets `tools.write_file` and `tools.edit_file`,
- neither touches the shared `tools.file` family mode — that is what the segment on either row is for.

### Authorization is still one family

The server gates every file operation through a single `tools.file` family. The split did **not** change that:

- the segment on **Read tools** and the segment on **Edit tools** read and write the *same* `tools.file` mode, so both rows always display the same family mode and either one can change it;
- a leaf checkbox still pins a per-operation `tools.<name>` override, which is how the group checkboxes keep the two rows independent;
- the mode values, the allowlist, and the timeouts are unchanged, so upgrading `mouaif` never migrates or rewrites an existing project's authorization block.

## Notes

- **One source of truth.** The classification lives in one small helper shared by every tree builder, so the chat card, the composer popup, the chat preset, project settings, and the agent editor cannot disagree about which tool is a read and which is an edit.
- **Unknown file tools default to the edit half.** A future file operation that is not classified yet is treated as a mutation, never silently granted as safe read-only.
- **Nothing changed server-side.** `FILE_TOOL_NAMES`, the `tools.file` family, the per-leaf override resolution, and every REST shape are untouched by this split — the change is which rows the tree draws.
- See [file-tools.md](./file-tools.md) for the tools themselves and [tool-tree.md](./tool-tree.md) for the tree's shared controls.
