# Chat artifacts

## Overview

Artifacts are files kept with one chat: what the agent produced and what you added. You manage them in a sheet, edit them in the Files editor, tag them in a message with `@`, and the agent can create, read and replace them. An MCP App can read an artifact through a small link in its HTML, so refreshing an app's data never means sending the whole app again.

Where artifacts are stored follows the project's own [settings storage](./project-settings-storage.md):

| Project setting | Where artifacts live | What that means |
| --- | --- | --- |
| **Store settings in app DB** on | The app database, `~/.mouaif/store.sqlite` | The project folder stays untouched. A command can't open an artifact directly, so the agent uses `export_artifact`. |
| Off (`.mouaif.json`, the default) | Files at `.mouaif/artifacts/<chatId>/<name>` in the project | Shell and file tools can use them directly, and a file a command writes there is an artifact too, if its name has no spaces. |

Everything else works the same either way. Flipping the switch in **Settings → Project → Technical details** moves the project's artifacts with it. Registering a project with that option on does the same. If a move fails, the switch stays where it was and nothing is lost. Deleting a chat deletes its artifacts.

## Usage

### Manage artifacts

Open **File tools → Artifacts** from the button beside the message box.

- **Upload files** adds artifacts. **New text** asks for a name and opens the empty file in the Files editor.
- Tap one to see its details. **Open in editor** opens text in the Files editor, and **Open** does the same for an image. Other files can be downloaded.
- **Use in message** puts `@artifact:<name>` in the message box.
- **Open as app** shows an `.html`, `.htm`, `.js` or `.mjs` artifact as an app in the chat, without a model turn. It waits for a running response to finish.
- **Download**, **Rename** and **Delete** do what they say. Renaming also updates the links in this chat's apps. Deleting asks first, and an app linking that artifact shows why it stopped until the artifact is back.

### Edit an artifact in the Files editor

Artifacts open in the same editor as project files, with highlighting, search and Draft Craft. There are three ways in:

- **Open in editor** in the sheet.
- The artifact's chip in the message box.
- **File tools → Files**, then **Artifacts of this chat** at the top of the project folder. Typing `artifact:` as the folder path goes there too.

An image, SVG included, opens as a preview, and **Edit** switches an SVG to its text. A file that is neither text nor an image opens its sheet instead. The editor opens files up to 1 MiB, so download anything larger.

**Manage** goes to the artifact's sheet to rename, delete, download or tag it. If the agent replaces the artifact while it is open, the editor shows the new text, unless you have unsaved edits.

### Tag an artifact in a message

Type `@`, then pick from **Artifacts** or tap that category. The message gets `@artifact:<name>`, with a chip you can tap or remove. Project files with the same name stay separate.

On send, for that turn only:

| Artifact | What the model receives |
| --- | --- |
| Text up to the mention limit (256 KB, `fileTagMaxBytes`) | The whole text |
| Larger text | A note to read it with `read_artifact` |
| PNG, JPEG, WebP or GIF up to 6 MiB | The image |
| Anything else | A note saying how to reach it: its path, or `export_artifact` |
| A name this chat does not have | A note saying so |

### What the agent can do

These native tools are in the **Chats** family, so they follow its Off / Ask / Allow permission. They only reach the current chat.

| Tool | What it does |
| --- | --- |
| `list_artifacts` | Lists the chat's artifacts, with each one's link, and its path when it is a real file. |
| `read_artifact` | Reads text a page at a time. `offset` and `limit` move through it, and `nextOffset` gives the next page. A PNG, JPEG, WebP or GIF up to 4 MB comes back as the picture. |
| `save_artifact` | Creates or replaces one from `content`, or copies a file with `path`. `description` is optional. Lines hidden with [Hide file content](./hide-file-content.md) stay hidden in the copy, and a hide rule also applies to an artifact stored as a file. |
| `delete_artifact` | Deletes one. |
| `export_artifact` | Writes a copy to a new file in the chat's working folder, so a command or file tool can use it. It always asks first, even when the family is **Allow**, and never replaces an existing file. A path that would land outside the folder through a symlink, including a new file below a linked folder or a dangling link, is refused. |

The agent is also told the names of the chat's artifacts at the start of each turn, so it doesn't need a call to learn what exists.

Other tools take `artifact:<name>` in place of a path, in either kind of project and whatever the chat's working folder is:

| Tool | With an artifact |
| --- | --- |
| `read_file`, `group_read` | Reads it like a file: `startLine` and `endLine` for text, and the picture for an image. These tools follow the file tools' permission. |
| `list_files` | `artifact:*` or `artifact:*.json` as the `pattern` lists artifacts it can read. |
| `search_files` | `artifact:<name>` as the `path` searches one, and `artifact:` searches them all. |
| `attach_chat_image` | Puts an image artifact in a draft or a message, up to 6 MiB. It reads from the calling chat's artifacts. |
| `write_file`, `edit_file` | Refused, with a note to use `save_artifact`. |

In a project that keeps its settings in the app DB, a command can't open an artifact directly. To process one with a script, the agent exports it, runs the script, and saves the result back with `save_artifact` and `path`.

### An app that reads a data file

The agent writes the app once, with a link to its data, and then only changes the data:

```html
<script type="application/json" id="data" src="artifact:sales.json"></script>
<img src="artifact:logo.png" alt="">
<script type="module">
  const rows = JSON.parse(document.getElementById('data').textContent);
</script>
```

1. `save_artifact` with `sales.json` stores the data.
2. `create_mcp_app` with `source` and `filename` creates the app. It is saved as an artifact of the chat, and this step needs your approval as usual. A link to an artifact that doesn't exist fails here, with nothing written.
3. For new data, `save_artifact` on `sales.json` is enough. The mounted app reloads by itself.
4. To read a different file, `create_mcp_app` with `relink` changes only the link and reloads the app:

```json
{ "path": "artifact:dash.html", "relink": { "sales.json": "sales-q2.json" } }
```

A relink follows the tool's ordinary permission rather than the approval new source always needs, because it can only change a name. A target that isn't a valid artifact name, or isn't in this chat, is refused and nothing is written.

Links work in HTML apps, in these forms:

| In the HTML | Becomes |
| --- | --- |
| `<script type="application/json" src="artifact:a.json">` (or `text/csv`, `text/plain`, …) | The same element with the file as its text. Read it with `textContent`. |
| `<script src="artifact:lib.js">` | An inline script. |
| `src`, `href` or `poster` set to `artifact:logo.png` | A `data:` URL. |
| `url(artifact:bg.webp)` in CSS | A `data:` URL. |

A reload starts the app over, so state kept only in the page is lost. To tell a running app something without reloading it, use `create_mcp_app` with `message`.

### Limits

- An artifact can be at most 16 MiB, and a chat at most 200 artifacts and 256 MiB. In a DB-backed project all of it counts toward the size of `store.sqlite`, and the file doesn't shrink when artifacts are deleted: SQLite reuses that space for new data.
- Names use letters, digits, `.`, `_` and `-`, with no spaces or folders. An uploaded file's name is adjusted to fit: `Mon fichier.txt` becomes `Mon-fichier.txt`.
- An app's source stays limited to 512 KiB. With its linked data, an app can be at most 8 MiB.
- Links are read from the current chat only.

## Links and reloads

Apps have no network, so links are inlined when the app mounts (`resolveLinks`), in `POST /api/mcp/apps/mount`. JSON and JavaScript escape `<` without changing their meaning. Other text containing `</script` or `<!--` is decoded into its element by an inline script, so it arrives unchanged.

Every write gives an artifact a new `revision`: a random token in the DB, size and modified time for a file. The mount records the revisions of the app's own artifact and its linked artifacts. `POST /api/mcp/apps/:mountId/status`, polled every 5 seconds, returns the current ones, and `McpAppFrame.jsx` mounts again when they differ. This covers every writer, including a shell command or another device. A save made in this page dispatches `ARTIFACTS_CHANGED` so the check happens right away.

## HTTP interface

All routes take `?projectDir=` and sit behind the normal origin and access checks.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/chats/:id/artifacts` | `{ artifacts }` |
| GET | `/api/chats/:id/artifacts/:name` | The file as a download. `&inline=1` draws a PNG, JPEG, WebP or GIF. `&text=1` returns `{ artifact, text }` with the whole text, up to 1 MiB, for the editor. |
| PUT | `/api/chats/:id/artifacts/:name` | Raw bytes as the body, optional `&description=`. Returns `{ artifact, created }`. |
| PATCH | `/api/chats/:id/artifacts/:name` | `{ name?, description? }` returns `{ artifact }`. |
| DELETE | `/api/chats/:id/artifacts/:name` | `{ removed }` |
| POST | `/api/chats/:id/artifacts/:name/open` | Shows the artifact as an app by writing a `create_mcp_app` call and result to the transcript. |

Artifacts share the app's origin, so the file route never lets one run there. Only raster images are served inline. Everything else, SVG included, is an `application/octet-stream` attachment with `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`. Uploads are read with a limit, so an oversized one stops at 16 MiB.

## Verification

```bash
npm run test:chat-artifacts   # the whole suite in both storage modes, plus switching
node scripts/test-at-mention-filter.mjs
```
