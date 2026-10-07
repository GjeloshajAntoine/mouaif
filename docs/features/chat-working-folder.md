# Chat working folders

## Overview

The `change_working_folder` chat tool gives a conversation its own working directory for isolated or partial development. It selects a directory that **already exists**, or returns the chat to the original project folder. It never creates a folder, never runs Git, and never manages branches: preparing a checkout or a workspace is an ordinary, separately authorized shell command.

## Usage

For implementation requests the built-in coding prompts tell the assistant to prepare a workspace with an authorized shell command, then point the chat at that existing folder with `change_working_folder` before editing or launching coding subagents. A folder you selected or requested is always kept, and a chat that has not switched keeps using the original project.

```text
Create an isolated Git worktree for this chat and implement the change there.
Switch this chat's working folder to ./packages/my-feature.
Return this chat to the original project folder.
```

The tool appears under **Chats** in the chat Tools card, composer tools popup, and Settings → Project → Tools. It inherits the Chats authorization family and supports its own Off / Ask / Allow override. Unconfigured permissions default to Ask: the model's call still needs normal tool approval, not a separate product question. Off or unselected tools cannot be used. This is prompt guidance, not automatic folder creation when a chat opens; chats use the original project until the tool succeeds.

### Arguments

`directory` is required and is always a directory name, so a call cannot mean anything except "use this folder" or "go back".

| Argument | Meaning |
| --- | --- |
| `directory: "packages/my-feature"` | Use an existing directory relative to the original project, not the previous working folder. |
| `directory: "/absolute/path"` | Use an existing absolute directory within the normal filesystem boundary. |
| `directory: ""` or `"."` | Return to the original project folder. |

`chatId` is optional and defaults to the calling chat:

| Argument | Meaning |
| --- | --- |
| `chatId` omitted | Act on the chat the tool was called from. |
| `chatId: "<id>"` | Act on that chat instead. |

Example tool arguments:

```json
{ "directory": "packages/my-feature" }
```

```json
{ "directory": "" }
```

```json
{ "directory": "packages/my-feature", "chatId": "a1b2c3d4" }
```

### Choosing the chat

`chatId` defaults to the chat the tool was called from, which is what you want almost every time. Naming another chat moves **that** chat's folder; the calling chat keeps its own. The approval card always names the chat that will change, so an explicit target is visible before it happens.

A call with no current chat and no `chatId` fails with a clear error rather than picking one.

### Subagents use their own folder

A delegated run gets independent working-folder state rather than changing the parent chat's. The run starts in whatever folder the parent chat is using, and a `change_working_folder` call from inside the run switches the run alone. Siblings share the same starting directory unless they explicitly select different existing folders.

Inside a run the `directory` argument means the same thing it does for a chat — an existing folder — but it resolves against the folder the run **started** in, not the project root and not the run's current folder. A fixed anchor is what keeps one argument meaning one folder; resolving against the current folder would make `sub-checkout` mean `sub-checkout` on the first call and `sub-checkout/sub-checkout` on the next. An empty `directory` returns the run to the folder it started in, which is the run's equivalent of a chat's reset.

A run never creates a folder: `created` is always `false` for it, and preparing a checkout stays a separately authorized shell call.

A run's folder is live process state, not chat metadata: it belongs to the run, is dropped when the run settles, and never appears in chat storage. The tool's approval card names the run and the parent chat it was delegated from, and describes the effect as applying to the run, because the parent conversation's folder is untouched.

Permissions, approval decisions, pending-request recovery, cancellation, tasks and tools such as `get_chat` and `list_chat_attachments` keep using the real parent chat. `attach_chat_image` reads from the run's current folder and saves into the target chat. If the selected parent folder is missing, delegation fails before launching the nested model instead of silently running in the original project. A folder that disappears during a run also fails on the next local-tool call.

### Approvals

The **Change working folder** approval tells you which chat will work in the shown folder and that files read or edited and commands run for it will use that location. It says **Use a different folder** or **Return to the project folder**, and explains that the change does not move or copy files. Chat titles appear before IDs; the folder and project paths remain visible. The same details survive reloading a pending approval; previewing the request does not create anything.

For existing directories, the approval and any allowlist match use the **real destination**, resolving symbolic links rather than showing only an alias. The tool resolves it again before changing the folder. If the destination changed while approval was pending, the call fails with `ESTALE_PATH` and keeps the current folder; request a fresh approval. Missing or invalid destinations fail validation instead of producing a misleading approval.

### Result

The result reports `workingDir` and the updated chat. `created` is always `false` and the legacy `branch` field is always `null`: this tool has nothing to report about folder creation or Git. The current folder also appears below the chat title and in `get_chat`.

Shell and file operations use the new folder immediately, including subsequent calls in the same turn, later turns, and delegated subagent tools. Composer `@shell` uses the same folder. `attach_chat_image` reads relative image paths from the calling chat's working folder while saving attachments to the target chat in the original project.

## Where workspaces come from

This tool deliberately does not create anything in your project. To work in an isolated copy, the assistant prepares one first with an authorized shell command — for example a Git worktree from committed `HEAD` on a new branch — and then selects that existing folder. You see and approve the command that creates it, and nothing is created behind your back.

- A workspace folder is **not** special: it is an ordinary directory, and any directory inside the project (or elsewhere within the home boundary) works.
- Add `.mouaif/` to the project's `.gitignore` if you keep scratch folders there and do not want them offered for staging.
- Repeating the same call keeps the folder exactly as it is; the tool never resets or cleans a directory.
- Uncommitted and untracked files, ignored dependencies, and build output are not copied by a worktree operation. Preserve unrelated work and get approval for dependency installation.

## Scope and safety

- Chat storage, models, settings, permissions, agent instructions, skills, tags, traces, and MCP connections remain in the original project. Project redaction rules continue to apply to workspace-relative reads and searches. This is not a security sandbox.
- Missing or removed working folders fail instead of silently sending tools back to the original project.
- Selected folders and resets enforce the same home-directory boundary as the project picker, including when a directory is replaced by a symbolic link during a run. Existing temporary projects inherited outside home retain their local-tool sandbox; selecting another directory explicitly uses the normal home guard. `MOUAIF_ALLOW_ANY_ROOT=1` remains the explicit opt-out.
- Subagents get independent folder state. A delegated run starts in the parent chat's folder, and `change_working_folder` called by a subagent moves **that run only** — the parent and siblings keep their folders. Parallel delegates still share one tree until they select different directories. Run folders live for the run: when it finishes, its folder is forgotten, and a stale run id fails instead of falling back to the project. Already-running operations keep their existing directory.
- Persistent project CLI sessions, editor browsing, and the Git UI remain project-scoped.
- The existing chat APIs expose `workingDir`. Composer shell requests continue taking the original `projectDir` and `chatId`; no new REST endpoint is needed.
