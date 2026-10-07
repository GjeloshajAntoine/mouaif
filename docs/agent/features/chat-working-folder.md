# Chat working folder implementation

## Overview

A nullable `workingDir` on a chat redirects local coding tools without changing the project's identity, settings, permissions, or transcript keys. `change_working_folder` is a native Chats-family function with normal selection and authorization. It selects an existing directory or resets to the project root — it creates nothing and never touches Git.

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

### Arguments

`directory` is a plain required string: an existing directory (project-relative or absolute) or `""`/`"."` to reset to the project root. It is no longer a `['string','boolean','null']` union, because the boolean/null forms only existed to reach the default workspace, which is gone. The chat, preview and run paths reject a non-string through one shared `directoryTypeError()`, so all three describe the argument the same way.

`chatId` is an ordinary optional argument defaulting to the calling chat — the same rule `get_chat` and `attach_chat_image` follow, resolved by `resolveWorkingFolderChatId()`. Before this, the tool owned its chat exclusively (decisions §35); `LEGACY_DEFINITIONS` in [src/tools/appToolNames.js](../../../src/tools/appToolNames.js) is still kept so the one-time migration keeps rewriting an old `mouaif:working_folder` permission row, but the live definition advertises `chatId` again.

`prepareChange()` resolves the target the same way the runner will (`workspaceChatId || args.chatId || currentChatId`), so the approval card can never name a different chat from the one the call moves.

### No folder creation

The default `.mouaif/workspaces/<chatId>` workspace, `createDefaultWorkspace()`, the `autoWorkspace` setting, its `EOFF` result, and both settings switches (`sp-auto-workspace`, `sd-auto-workspace`) were removed in [src/settings.js](../../../src/settings.js), [src/chatWorkingFolder.js](../../../src/chatWorkingFolder.js), [frontend/src/components/SettingsProject.jsx](../../../frontend/src/components/SettingsProject.jsx) and [frontend/src/components/SettingsDefaults.jsx](../../../frontend/src/components/SettingsDefaults.jsx). Preparing a checkout stays a separately authorized shell call, so the command that creates a directory is visible to the user (decisions §34).

That also removed `change()`'s per-chat `EBUSY` guard, which existed only to serialize overlapping folder creation: with no `await` between the validation and the single-field write, two calls cannot interleave, so the guard became dead code rather than a race to test.

A store that ran the old switch keeps an inert `autoWorkspace` row, so the one-time migration `2026-10-07-drop-automatic-workspaces` deletes it from the app row and from every registered project, plus every project-scoped `project_settings` / `chat_store` row. It skips a project file it cannot parse (logged, not rewritten) and guards the two lazily-created tables with `tableExists()`, because migrations run before any chat or project read. Regression test: [scripts/test-automatic-workspace-migration.js](../../../scripts/test-automatic-workspace-migration.js).

`created` stays in the result as `false` and `branch` as `null`, so existing readers keep working.

### Delegated runs

A delegated run keeps the real parent `opts.chatId` for permissions, approval sessions, images, tasks and app tools. Each run separately registers folder state under a synthetic id `subagent:run-<n>` and passes it as `opts.workspaceChatId`. Replacing `opts.chatId` with a synthetic id would bypass chat-specific Ask settings, strand approvals outside the parent session and break tools that default to the current chat.

- `registerRun(root, workspace, parentChatId)` in [src/chatWorkingFolder.js](../../../src/chatWorkingFolder.js) keys the store by run id alone (ids are unique process-wide), so the nested launch — which holds the parent's folder — and tool dispatch — which holds the original project dir — need not agree on a root. `clearRun(runId)` drops the entry in the nested run's `finally`.
- `resolveForCall(projectDir, chatId, workspaceChatId)` resolves the registered run folder when a separate run id is present, validates that directory on every local call, and fails with `ENOTFOUND` for an unknown run rather than falling back. `runDirectory` applies `safeDirectory` to selected folders and resets; only an inherited outside-home project retains `resolveSandbox`. Explicit run selections turn on the normal home guard, and resets restore the starting policy. Ordinary chats still go through `resolve`.
- `runAppTool` receives the unchanged call context. `resolveWorkingFolderChatId` reads the real `opts.chatId` (or `args.chatId`), and the working-folder action separately consumes `opts.workspaceChatId`. Attachment reads use the same run-folder resolver while attachment storage keeps the real target chat.
- Delegation resolves its starting folder before launching the nested stream and propagates failures. It must never catch a missing selected folder and replace it with the original project. Nested authorization events, pending recovery and Stop remain keyed by the real parent chat.
- `changeRun` resolves a relative `directory` against the run's **start** folder — captured at registration, so the anchor never moves — never the project root and never the run's current folder. `created` is always `false`: a run selects an existing folder and creates nothing. `""` means "back to the folder the run started in", the run's equivalent of a reset; a missing or non-string `directory` fails like it does for a chat.
- `registerRun(root, workspace, parentChatId)` also records the parent chat id for the approval label. `describeChange` receives the real chat id and separate run id, so the card names both the run and the correct parent.
- The working-folder action detects `opts.workspaceChatId` and returns `updated: []` / `chat: null`, so switching a run never writes chat metadata or triggers a UI metadata refresh.

### Storage and dispatch

- `src/chatdb.js` adds `working_dir` lazily to old databases and maps it for full reads, list/search summaries, inserts and merged updates. `src/chats.js` permits the internal field; generic HTTP PATCH strips it so clients cannot bypass folder validation.
- `src/promptProfiles.js` states in the shared core that `change_working_folder` selects an EXISTING directory, creates nothing, never runs Git, and that a checkout must be prepared with an authorized shell command first. Selected/user-requested folders are kept and approval gates stay intact. The Chat profile remains empty. The tool description carries the same facts so compact schemas and Chat-profile tool use see them. Average and Extensive separately guide Git isolation through authorized shell calls.
- `src/tools/appToolNames.js` registers the function; `src/tools/mouaif.js` resolves the target chat and reports `workingDir`, `branch`, `created`, `updated` and a chat summary. Image attachment reads resolve the calling chat's folder while writes remain anchored to the target chat's original project.
- `src/ai-stream.js` resolves the current saved folder for every shell/file dispatch, so same-turn calls and nested agents pick up changes immediately. Later turns include a working-folder system message. Project-scoped configuration is never relocated.
- File reads, grouped reads and both search backends receive `settingsProjectDir` for redaction. Search/containment still uses the working root. The existing composer shell route resolves the same folder after authorization and before opening NDJSON output.
- `prepareChange()` resolves a canonical destination and summary together before authorization. The dispatcher passes `workingFolderDestination` as server-only context; `change` / `changeRun` re-resolve and compare before mutating, returning `ESTALE_PATH` when a link or root changed. Missing explicit directories fail preflight. `describeChange()` wraps the same preflight for summary callers and produces a side-effect-free, user-facing summary before authorization: the action, chat title then ID, folder, and effect on that chat's file/shell tools. Implementation details such as Git do not appear. `src/ai-stream.js` passes it through the existing authorization summary field so live and recovered pending approvals agree. `frontend/src/components/chat/cards.js` shows a **Change working folder** heading, that summary and the project path instead of a raw tool identifier and irrelevant shell timeout.
- `frontend/src/toolGroups.js` places the tool in the shared Chats tree. `frontend/src/components/chat/meta.js` synchronizes successful changes (including nested/follower results) and displays the folder below the title; long paths wrap on mobile.
- Workspace cleanup is intentionally manual; deleting a chat or resetting the folder never discards work. MCP, editor, project CLI, Git UI, tags, agent instructions and skill configuration retain original project scope. Concurrent subagents share their starting folder unless they select different directories; a run's folder change never redirects its parent or siblings.
