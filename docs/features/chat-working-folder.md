# Chat working folders

## Overview

The `change_working_folder` chat tool gives a conversation its own working directory for isolated or partial development. By default it creates a workspace under the original project's `.mouaif/`; in a Git repository this is a separate Git worktree and branch, without changing the original checkout.

## Usage

For implementation requests, the built-in coding prompts tell the assistant to create a workspace before editing or launching coding subagents, **even if you did not ask for a folder**. They suggest `.mouaif/workspaces/<chatId>` and tell it to keep any selected or explicitly requested folder. Questions and reviews do not need a new workspace.

You can also choose the folder explicitly:

```text
Create an isolated Git workspace for this chat and implement the change there.
Switch this chat's working folder to ./packages/my-feature.
Return this chat to the original project folder.
```

The tool appears under **Chats** in the chat Tools card, composer tools popup, and Settings → Project → Tools. It inherits the Chats authorization family and supports its own Off / Ask / Allow override. Unconfigured permissions default to Ask: proactive use still needs normal tool approval, not a separate product question. Off or unselected tools cannot be used. This is prompt guidance, not automatic folder creation when a chat opens; chats use the original project until the tool succeeds. The plain Chat profile has no coding system guidance, but the tool description still recommends proactive use for implementation work.

### Arguments

| Argument | Meaning |
| --- | --- |
| `chatId` | Target chat; omitted means the current chat. |
| `directory` omitted | Create or reuse `<project>/.mouaif/workspaces/<chatId>`. |
| `directory: "packages/my-feature"` | Use an existing directory relative to the original project, not the previous working folder. |
| `directory: "/absolute/path"` | Use an existing absolute directory within the normal filesystem boundary. |
| `directory: ""` or `"."` | Return to the original project folder. |

Example tool arguments:

```json
{}
```

```json
{ "directory": "packages/my-feature" }
```

The result reports `workingDir`, `branch`, `created`, and the updated chat. The current folder also appears below the chat title and in `get_chat`. Shell and file operations use the new folder immediately, including subsequent calls in the same turn, later turns, and delegated subagent tools. Composer `@shell` uses the same folder. `attach_chat_image` reads relative image paths from the calling chat's working folder while saving attachments to the target chat in the original project.

### Git workspaces

For a Git project, the default creates a worktree from committed `HEAD` on branch `mouaif/chat-<chatId>`:

```text
<project>/.mouaif/workspaces/<chatId>
```

- The original checkout, branch, and uncommitted changes are untouched.
- Uncommitted and untracked files, ignored dependencies, and build output are **not copied**. Install dependencies in the workspace if needed.
- Git must be installed and the repository must have a commit. Git failures leave the chat's previous working folder unchanged.
- Repeating the default call reuses the matching worktree without resetting edits. An unrelated existing folder or branch collision is rejected, never overwritten.
- Add `.mouaif/` to the project's `.gitignore` so the original checkout does not offer the workspace directory for staging.
- Without a Git repository, the default creates an empty directory, not a copy of the project.

Commit the workspace's changes and merge its branch when ready; merging is not automatic. Switching folders, resetting to the project, or deleting a chat never removes a workspace or branch. Clean them up manually only after preserving your work.

## Scope and safety

- Chat storage, models, settings, permissions, agent instructions, skills, tags, traces, and MCP connections remain in the original project. Project redaction rules continue to apply to workspace-relative reads and searches. This is not a security sandbox.
- Missing or removed working folders fail instead of silently sending tools back to the original project.
- Subagents share the chat's working folder: change it before starting parallel delegates. Already-running operations keep their existing directory.
- Persistent project CLI sessions, editor browsing, and the Git UI remain project-scoped.
- The existing chat APIs expose `workingDir`. Composer shell requests continue taking the original `projectDir` and `chatId`; no new REST endpoint is needed.
