# Chat artifacts — implementation notes

> Agent-facing reference for [`docs/features/chat-artifacts.md`](../../features/chat-artifacts.md). The human-facing surface, the HTTP interface and the link forms live in that file; this one records where the pieces are and why they are shaped this way.

## Files

| Concern | File |
| --- | --- |
| The two stores, and which one a project uses | `src/artifactStores.js` (`dbStore`, `fileStore`, `storeFor`) |
| Names, limits, links, mentions, moving between stores | `src/artifacts.js` |
| Removal with the chat | `src/chatdb.js` `deleteChat`: rows inside its transaction, the folder after it commits |
| Moving on a storage switch | `src/server-handlers-settings.js`, `src/server-handlers-projects.js` (register) |
| REST routes | `src/server-handlers-artifacts.js`, matched in `src/http-server.js` before the generic chat router |
| Tool definitions | `src/tools/appToolNames.js` (`source: 'chats'`) |
| Tool schemas and runner | `src/tools/mouaif.js` (`artifacts` area) |
| Rendering links into an app | `src/instant-mcp-apps.js` (`renderHtml` `options.link`, `createApp` `context.chatId`) |
| Revision on mount and status | `src/server-handlers-mcp-apps.js` |
| Mention injection | `src/server-handlers-chats.js`, right after tagged files |
| Sheet | `frontend/src/components/chat/ArtifactsModal.jsx`, `artifacts.css` |
| Editing | `frontend/src/components/FileEditor.jsx` (`artifact:` paths in its API helpers) |
| `artifact:` in the file tools | `src/tools/files.js` (`readArtifactFile`, `listArtifactFiles`, `searchArtifactFiles`), `src/tools/searchEngine.js` (`searchTexts`) |
| `artifact:` in `attach_chat_image` | `src/tools/mouaif.js` (`loadArtifactAttachment`) |
| `@` category and chips | `frontend/src/components/chat/atMention.js` |
| Reload on change | `frontend/src/components/chat/McpAppFrame.jsx`, `meta.js`, `extensionEvents.js` (`ARTIFACTS_CHANGED`) |

## Decisions

- **Storage follows the project's configuration.** A project chooses where its settings live (`__dbBacked`, see [project settings storage](./project-settings-storage.md)), and that choice means "keep this project untouched" or "keep it with the project". Artifacts honor the same choice: `chat_artifact` rows when DB-backed, `.mouaif/artifacts/<chatId>/` otherwise. Earlier versions used only files, then only the DB; neither respected the choice.
- **Move on switch, unlike settings.** Toggling settings on leaves `.mouaif.json` in place. Artifacts move instead: a leftover copy would be stale data in a project that asked to stay untouched, and would come back when switching off. `moveStorage` copies everything before removing anything, and runs before the flag flips, so a failure changes nothing.
- **`export_artifact` is the way to a file in a DB-backed project.** A command can't open a row, so the agent exports, runs the command, and saves back with `path`. The export always prompts: it writes to the project, and the Chats family's Allow must not stand in for the file tools' permission.
- **`@artifact:<name>`, not a bare `@name`.** A bare token already means a project file. The prefix can't collide, and `tags.parseReferences` skips it, so a mention doesn't trigger a project scan.
- **Links resolve at mount, not at save.** The source on disk keeps its small `artifact:` link, which is what makes a relink a one-word change. The cost is that every mount reads the data.
- **Change detection is a revision in `/status`.** The existing 5-second poll reaches every mounted view and sees changes from any source. `ARTIFACTS_CHANGED` only makes that check run sooner; it never reloads anything itself, so there is one reload path.
- **One editor.** The sheet used to have its own text box. Artifacts now open in the Files editor, so they get highlighting, search and Draft Craft, and the sheet only manages them.
- **The sheet is a participant in the shared idiom, not a bottom sheet.** The overlay and the sheet are declared once in `frontend/src/sheets.css`; `.artifacts.css` only sets `--sheet-width: 45rem`, `--sheet-max-width: 54rem` and `--sheet-height: min(80vh, 45rem)` — narrower than Git's 860/1000px because a row here is a name plus one meta line, and in `rem` so the card follows the reader's text size. It kept its own copy for a while as a bottom sheet at every width (`align-items: flex-end`, `height: 92dvh`, `max-width: 44rem`), so on a desktop window it stayed a phone-shaped strip pinned to the bottom edge and never centred. Anything that needs to change the backdrop or the centring belongs in `sheets.css`, so the six other sheets change with it.
- **The head is the app's sheet bar.** `.artifacts__head` copies `.gm__head`'s `--surface-2` strip and the glyph buttons are `.icon-btn` / `.icon-btn--close` at `var(--tap)`. The old bar was a `btn` labelled "Close" and a `‹` character, which read as page content rather than a sheet header. The back glyph only renders away from the list, as before; the bar's height does not change with the view, because the body below it is the sheet's only scroller and a head that grew would move the whole card.
- **`artifact:` in the read tools only.** A read can't harm anything, and the agent would otherwise need a different tool or an export in a DB-backed project. Writes stay with `save_artifact`, which is what records who made an artifact and enforces its limits. `write_file` and `edit_file` refuse the prefix, or they would create a project file literally named `artifact:x`.
- **Relink skips the forced approval.** `forcePrompt` exists because new source is new code. `relink` validates its target against the name pattern and rewrites only `artifact:` tokens, so it can't change what the code does.
- **A new app from a chat is an artifact.** That puts it in the sheet, and its tool result's `path` is `artifact:<name>` in either store, which `readAppSource` and the mounted card treat as an address, so an open app survives a storage switch. Apps from the Settings import route have no chat, so they stay files in `.mouaif/mcp-apps/`.
- **`revision` is the store's to define.** A random token in the DB, because a write and a delete-then-create must look different to a mounted app. Size and modified time for a file, because anything can write to the folder.

## Watch out for

- `renderHtml` checks the authored source against 512 KiB, and only the result against the larger limit. Linked data must not count toward the source limit.
- `.js` and `.mjs` apps have no document to rewrite, so links only resolve in HTML. `relink` on one still rewrites the text, but nothing reads it.
- `mentionMessages` must not page through `readText`: a file under the mention limit can be longer than one page.
- `openAsApp` refuses while the chat is running. Rows appended mid-turn would interleave with the running turn's tool rows.
- `scripts/test-tool-groups.mjs` compares `frontend/build/toolGroups.json` to the model. After changing a group, run `node scripts/build-tool-groups.js`.
- `storeFor` reads `settings.isDbBacked`, keyed by the path as typed, while the app tools resolve symlinks. `createApp` therefore takes `context.projectDir`, and the mount handler passes the request's `projectDir`. Pass a resolved path and a symlinked DB project silently writes to its folder.
- `projectKey()` resolves symlinks for the same reason in reverse, so one project is one set of rows.
- Hide rules follow project paths, so they only match an artifact stored as a file. `readWhole` applies them when it has a path, and `importedBytes` applies the source file's rules when a file is copied in. The editor route reads without redaction, or saving would write the markers into the file.
- New code must go through `storeFor`, never one store directly. The exceptions are `moveStorage` and chat deletion, which clears both.
- File tools get `settingsProjectDir` as the owner of an artifact, never `projectDir`, which is the working folder. They also need `chatId` from `ai-stream.js`.
- Text read through `read_file` is redacted with `artifact.path`, because a rule can only name a real file. `readForEditor` never redacts, or saving would write the markers into the file.
- `FileEditor.jsx` opens `initialPath` through a ref. The open callbacks change when the file becomes dirty, and an effect depending on them would open the file again on the first keystroke.
- `savedContentRef` is set before the save request, because the change event can arrive before the response. Otherwise the editor would treat its own save as a change from the agent.
- A chat's mounted card keeps the path it was created with, so renaming an app's own artifact shows "renamed or deleted" on that card until it is opened again. Renaming linked data is fine: the links are rewritten.

## Tests

`scripts/test-chat-artifacts.js` runs the real tools, routes and mount in both storage modes, then the switch in both directions, a failed move, registration and a symlinked project. `scripts/test-at-mention-filter.mjs` covers the category and chips. The sheet and the editor's artifact folder have no automated browser test: check the sheet in the Docker test app at 360 px (full-bleed, one scroller under the head, two-up action grid, rename/delete confirms) and in a desktop-width window (a centred card, 45rem wide, capped at 54rem, no bottom-sheet strip).

## Notes from the public page

- `src/artifactStores.js` holds the two stores behind one small interface, and `storeFor` picks one with `settings.isDbBacked`. `src/artifacts.js` holds everything that doesn't depend on which: names, limits, links and mentions.
- The DB store is the `chat_artifact` table, keyed by project, chat and name. Listings never load the content. Its rows are deleted in the same transaction as their chat.
- The file store treats the folder as the source of truth, with `.artifacts.json` adding the description, who made it and when. Only regular files count: a symlink in the folder is never listed or read, and a symlink taking the store out of the project is refused.
- `moveStorage` runs before a switch takes effect, from `PUT /api/settings/project/storage` and from registering a project. It copies everything first and removes the old copies last.
- `src/tools/mouaif.js` holds the `artifacts` area, and `src/tools/appToolNames.js` the tool definitions.
- `src/instant-mcp-apps.js` `createApp` takes the chat as `context.chatId`. An app created from a chat is an artifact, addressed as `artifact:<name>` in either store. Without a chat (the Settings import route), apps are still files in `.mouaif/mcp-apps/`, and links stay unresolved until a chat mounts the app.
- A copy made with `save_artifact` and `path` keeps the source file's hidden lines hidden, whichever store it lands in.
- `src/tools/files.js` handles `artifact:` paths before any path checks, using the project's own path rather than the working folder. `FileEditor.jsx` does the same in its API helpers, so the rest of the editor treats an artifact as a path.
