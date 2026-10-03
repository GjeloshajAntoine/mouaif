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

- `src/chatWorkingFolder.js` validates explicit real directory paths against the project picker's home boundary. Unchanged chats retain the existing file-tool sandbox, including support for temporary projects outside home. Missing selected folders fail rather than falling back.
- Default folders are `.mouaif/workspaces/<chatId>`, and creating one is opt-in: `change()` refuses with `EOFF` unless the resolved settings set `autoWorkspace` (`false` in `src/settings.js` DEFAULTS, project-scoped switch "Allow automatic workspaces" in Settings → Project → General). An unreadable settings store counts as off. Explicit `directory` strings never create anything and never consult the switch. The parent chain is preflighted (redirected state/workspace symlink parents are rejected before creating children) and created lazily: `.mouaif` / `.mouaif/workspaces` are `mkdir`'d only after the Git check and just before the worktree or plain folder, so a failed or cancelled change creates nothing. `prune()` then removes only the directories the call itself created, innermost first and only while empty, so a pre-existing folder or a workspace holding work survives. Git runs through `execFile`, with a bounded timeout and argument arrays rather than shell interpolation.
- Git worktrees start from committed `HEAD` on `mouaif/chat-<chatId>`. Reuse checks the real target, repository common directory, root and branch; no force, reset, delete, merge or checkout of the original project occurs. Non-Git projects receive an empty folder. Per-chat locks reject overlapping folder changes; shared-parent creation tolerates concurrent chats, and a failed call only prunes directories that are still empty.
- `src/chatdb.js` adds `working_dir` lazily to old databases and maps it for full reads, list/search summaries, inserts and merged updates. `src/chats.js` permits the internal field; generic HTTP PATCH strips it so clients cannot bypass folder validation.
- `src/promptProfiles.js` explains the opt-in in the shared core for Very small, Average and Extensive: default workspaces need the project's `autoWorkspace` switch, so call the enabled tool once before implementation edits/delegates and keep working in the project folder when it returns `EOFF`. Questions/reviews never create one, selected/user-requested folders are kept, and approval gates stay intact. The Chat profile remains empty. The tool description carries the same facts so compact schemas and Chat-profile tool use see them. This is model guidance, not server-side unconditional creation.
- `src/tools/appToolNames.js` registers the function; `src/tools/mouaif.js` resolves current/explicit chat IDs and reports `workingDir`, `branch`, `created`, `updated` and a chat summary. Image attachment reads resolve the calling chat's folder while writes remain anchored to the target chat's original project.
- `src/ai-stream.js` resolves the current saved folder for every shell/file dispatch, so same-turn calls and nested agents pick up changes immediately. Later turns include a working-folder system message. Project-scoped configuration is never relocated.
- File reads, grouped reads and both search backends receive `settingsProjectDir` for redaction. Search/containment still uses the working root. The existing composer shell route resolves the same folder after authorization and before opening NDJSON output.
- `frontend/src/toolGroups.js` places the tool in the shared Chats tree. `frontend/src/components/chat/meta.js` synchronizes successful changes (including nested/follower results) and displays the folder below the title; long paths wrap on mobile.
- Workspace cleanup is intentionally manual; deleting a chat or resetting the folder never discards work. MCP, editor, project CLI, Git UI, tags, agent instructions and skill configuration retain original project scope. Concurrent subagents share a folder and should not change it during parallel edits.
