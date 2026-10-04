# Chat working folder implementation

## Overview

A nullable `workingDir` on a chat redirects local coding tools without changing the project's identity, settings, permissions, or transcript keys. `change_working_folder` is a native Chats-family function with normal selection and authorization.

## Usage

Run isolated backend, metadata synchronization, tool-tree and real mobile-width regressions:

```bash
npm run test:chat-working-folder
npm run test:mouaif-tool
node scripts/test-grouped-file-tools.js
node scripts/test-search-engine.js
npm run lint
npm run build:web
```

## Implementation notes

- `src/chatWorkingFolder.js` validates explicit real directory paths against the project picker's home boundary and creates empty folders without Git dependencies or child-process calls. Unchanged chats retain the existing file-tool sandbox, including support for temporary projects outside home. Missing selected folders fail rather than falling back.
- Default folders are `.mouaif/workspaces/<chatId>`, and creating one is opt-in: `change()` refuses with `EOFF` unless the resolved settings set `autoWorkspace` (`false` in `src/settings.js` DEFAULTS). The project switch is a row in Settings → Project → General (`sp-auto-workspace`); the app-level default is a row in Settings → App defaults → Chat defaults (`sd-auto-workspace`); the server allowlists `autoWorkspace` in `CLIENT_SETTINGS_KEYS`. The project value rides the project payload, which is sent whole. The switch is deliberately NOT on the tool-tree row: a 44px control cannot fit a 26px dense tree row without changing shared tree layout (an earlier attempt did exactly that and was reverted in `d166fe4c`). An unreadable settings store counts as off. Explicit `directory` strings never create anything and never consult the switch. The parent chain is preflighted (redirected state/workspace symlink parents are rejected before creating children), then missing parents and the empty target are created. `prune()` removes newly created directories after a creation error, innermost first and only while empty, so pre-existing work survives. A pre-aborted call creates nothing.
- All projects receive an empty folder regardless of Git availability or repository state. Existing directories, including externally prepared worktrees, are reused unchanged; symlink targets and files are rejected. The legacy `branch` result stays `null`. Per-chat locks reject overlapping folder changes; shared-parent creation tolerates concurrent chats.
- `src/chatdb.js` adds `working_dir` lazily to old databases and maps it for full reads, list/search summaries, inserts and merged updates. `src/chats.js` permits the internal field; generic HTTP PATCH strips it so clients cannot bypass folder validation.
- `src/promptProfiles.js` explains the opt-in in the shared core for Very small, Average and Extensive: default workspaces need the project's `autoWorkspace` switch, so call the enabled tool once before implementation edits/delegates and keep working in the project folder when it returns `EOFF`. Questions/reviews never create one, selected/user-requested folders are kept, and approval gates stay intact. The Chat profile remains empty. The tool description carries the same facts so compact schemas and Chat-profile tool use see them. This is model guidance, not server-side unconditional creation. Average and Extensive separately guide Git isolation through authorized shell calls: inspect existing state, prepare/reuse a committed-HEAD worktree on a unique branch when needed, preserve work and switch to the existing directory. No Git policy lives in the directory tool.
- `src/tools/appToolNames.js` registers the function; `src/tools/mouaif.js` resolves current/explicit chat IDs and reports `workingDir`, `branch`, `created`, `updated` and a chat summary. Image attachment reads resolve the calling chat's folder while writes remain anchored to the target chat's original project.
- `src/ai-stream.js` resolves the current saved folder for every shell/file dispatch, so same-turn calls and nested agents pick up changes immediately. Later turns include a working-folder system message. Project-scoped configuration is never relocated.
- File reads, grouped reads and both search backends receive `settingsProjectDir` for redaction. Search/containment still uses the working root. The existing composer shell route resolves the same folder after authorization and before opening NDJSON output.
- `describeChange()` produces a side-effect-free, user-facing summary before authorization: the action, chat title then ID, folder, and effect on that chat's file/shell tools. Separate-folder approvals explain empty-folder creation and that project files are not copied; implementation details such as Git do not appear. `src/ai-stream.js` passes it through the existing authorization summary field so live and recovered pending approvals agree. `frontend/src/components/chat/cards.js` shows a **Change working folder** heading, that summary and the project path instead of a raw tool identifier and irrelevant shell timeout.
- `frontend/src/toolGroups.js` places the tool in the shared Chats tree. `frontend/src/components/chat/meta.js` synchronizes successful changes (including nested/follower results) and displays the folder below the title; long paths wrap on mobile.
- Workspace cleanup is intentionally manual; deleting a chat or resetting the folder never discards work. MCP, editor, project CLI, Git UI, tags, agent instructions and skill configuration retain original project scope. Concurrent subagents share a folder and should not change it during parallel edits.
