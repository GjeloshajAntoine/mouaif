# Hide file content

## Overview

Hide chosen lines, or chosen text inside a line, from the agent's file tools. The agent sees `[hidden]` in their place, and the file on disk is never changed.

This is **not a security boundary**: shell commands and MCP servers can still read the original file. See [Limits](#limits).

## Usage

Open **Settings → This project → More settings → Hide file content**. The **?** next to **Hidden files** has a short version of these steps.

1. Tap **+ Add file** and choose a file, or tap a file already on the list.
2. The file opens read-only in a CodeMirror editor with line numbers and syntax highlighting. The header shows the file name and its folder.
3. **Hide a whole line:** tap its line number. A hidden line's number turns into a filled pill and the line is highlighted. Tap the number again to show the line.
4. **Hide part of a line:** select the text, then tap **Hide selection** in the footer. To undo, select exactly the same text again; the button then reads **Show selection**. A selection that spans several lines hides everything from its start to its end.
5. **Type line numbers instead:** tap **Ranges** in the footer, then enter **From** / **To** line numbers (both included). Use this for long blocks, or when the file can't be previewed (for example, files over 1 MiB).
6. Tap **Save**. The footer shows what will be hidden, for example `Lines 3–5 · Text on line 8, cols 4–9`, with an **Unsaved** badge until you save.

**Back** keeps your unsaved changes until you return to the same file, but they are lost on a page reload. **Cancel** asks before discarding them.

### Showing content again

| To show again | Do this |
| --- | --- |
| One line | Tap its line number in the editor, then **Save**. |
| A typed line range | **Ranges** → **×** on that row → **Save**. |
| Hidden text | Select the same text, tap **Show selection**, then **Save**. |
| A whole file | Tap **Remove** on its row in the list, then confirm. |

The agent can read the content again on its next file-tool call.

## What the agent sees

Say `src/secrets.js` contains:

```js
const apiKey = "sk-live-1234";
const normal = 1;
const token = "abc";
```

With the text inside the first string hidden and line 3 hidden, the list shows `Lines 3 · Text on line 1, cols 17–28`. A `read_file` call returns:

```text
# File: src/secrets.js
# Lines: 1-3

const apiKey = "[hidden]";
const normal = 1;
[hidden]
```

A `search_files` match that falls inside hidden content is left out of the results. Line numbers stay the same as in the real file.

## Limits

- Hiding applies to `read_file`, `search_files`, and files attached to a chat with a tag or an `@` mention, including reads of part of a file.
- Shell commands, MCP servers, and any other access still see the original file.
- Rules follow line and column numbers, not the text. If you edit the file, open it here and check what is hidden.
- Rules are saved per project in the project's settings, under `hideFileContent`.

## Related

- [File tools](./file-tools.md)
- [Tool authorization](./tool-authorization.md)
- [Project settings storage](./project-settings-storage.md)
