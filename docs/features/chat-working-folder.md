# Chat working folders

## Overview

The `change_working_folder` chat tool gives a conversation its own working directory for isolated or partial development. It can switch to an existing directory, or create a default workspace under the original project's `.mouaif/` (in a Git repository a separate Git worktree and branch, without changing the original checkout). Creating that default workspace is **opt-in**, off by default.

## Usage

For implementation requests the built-in coding prompts tell the assistant to call `change_working_folder` once before editing or launching coding subagents. It creates a workspace **only when the project enables _Allow automatic workspaces_**, which is off by default: with the option off the tool returns `EOFF` and the assistant keeps working in the project folder. Questions and reviews never need a workspace, and a folder you selected or requested is always kept. Turning the option off is therefore the difference between "the model may isolate itself" and "the model only changes folders when you ask".

You can also choose the folder explicitly:

```text
Create an isolated Git workspace for this chat and implement the change there.
Switch this chat's working folder to ./packages/my-feature.
Return this chat to the original project folder.
```

The tool appears under **Chats** in the chat Tools card, composer tools popup, and Settings → Project → Tools. It inherits the Chats authorization family and supports its own Off / Ask / Allow override. Unconfigured permissions default to Ask: the model's call still needs normal tool approval, not a separate product question. Off or unselected tools cannot be used. This is prompt guidance, not automatic folder creation when a chat opens; chats use the original project until the tool succeeds. The Chat profile has no coding system guidance, but the tool description still explains the opt-in and the `EOFF` result.

### Arguments

| Argument | Meaning |
| --- | --- |
| `chatId` | Target chat; omitted means the current chat. |
| `directory: "packages/my-feature"` | Use an existing directory relative to the original project, not the previous working folder. |
| `directory: "/absolute/path"` | Use an existing absolute directory within the normal filesystem boundary. |
| `directory: ""` or `"."` | Return to the original project folder. |
| `directory` omitted or `directory: false` | Create or reuse `<project>/.mouaif/workspaces/<chatId>`. Requires _Allow automatic workspaces_; otherwise the call fails with `EOFF` and nothing is created. |

Example tool arguments:

```json
{}
```

```json
{ "directory": "packages/my-feature" }
```

The result reports `workingDir`, `branch`, `created`, and the updated chat. The current folder also appears below the chat title and in `get_chat`. Shell and file operations use the new folder immediately, including subsequent calls in the same turn, later turns, and delegated subagent tools. Composer `@shell` uses the same folder. `attach_chat_image` reads relative image paths from the calling chat's working folder while saving attachments to the target chat in the original project.

### Automatic workspaces

Creating the default workspace is controlled by the **Allow automatic workspaces** switch in Settings → Project → **General**, with an app-level default in Settings → App defaults → Chat defaults. The option is stored as `autoWorkspace` (in `.mouaif.json`, or the app store when the project is DB-backed). It is `false` everywhere by default, and the resolved value is defaults → app → project, so either level can turn it on.

| `autoWorkspace` | `change_working_folder` with no `directory` |
| --- | --- |
| off (default) | Fails with `EOFF`, referring the user to the switch. Nothing is created, and the chat's folder is unchanged. |
| on | Creates or reuses `<project>/.mouaif/workspaces/<chatId>` as described below. |

Explicit `directory` strings are unaffected: selecting an existing folder or resetting to the project root always works, on or off, and never creates anything. An unreadable or corrupt project file counts as off — a configuration error is never a reason to write to the user's checkout.

### Git workspaces

With _Allow automatic workspaces_ on, a Git project gets a worktree from committed `HEAD` on branch `mouaif/chat-<chatId>`:

```text
<project>/.mouaif/workspaces/<chatId>
```

- The original checkout, branch, and uncommitted changes are untouched.
- Uncommitted and untracked files, ignored dependencies, and build output are **not copied**. Install dependencies in the workspace if needed.
- Git must be installed and the repository must have a commit. Git failures leave the chat's previous working folder unchanged **and create nothing on disk**: `.mouaif/workspaces/<chatId>` and its parents appear only once the worktree is in place, so a failed or cancelled change never leaves empty folders behind.
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
