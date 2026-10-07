# Chat working folders

## Overview

The `change_working_folder` chat tool gives a conversation its own working directory for isolated or partial development. It switches to an existing directory, or creates an empty default workspace under the original project's `.mouaif/`. Creating that folder is **opt-in**, off by default; the tool never runs Git or manages branches.

## Usage

For implementation requests the built-in coding prompts tell the assistant to call `change_working_folder` once before editing or launching coding subagents. It creates a workspace **only when the project enables _Allow automatic workspaces_**, which is off by default: with the option off the tool returns `EOFF` and the assistant keeps working in the project folder. Questions and reviews never need a workspace, and a folder you selected or requested is always kept. Turning the option off is therefore the difference between "the model may isolate itself" and "the model only changes folders when you ask".

You can also choose the folder explicitly:

```text
Create an isolated Git workspace for this chat and implement the change there.
Switch this chat's working folder to ./packages/my-feature.
Return this chat to the original project folder.
```

The tool appears under **Chats** in the chat Tools card, composer tools popup, and Settings → Project → Tools. It inherits the Chats authorization family and supports its own Off / Ask / Allow override. Unconfigured permissions default to Ask: the model's call still needs normal tool approval, not a separate product question. Off or unselected tools cannot be used. This is prompt guidance, not automatic folder creation when a chat opens; chats use the original project until the tool succeeds. The Chat profile has no coding system guidance, but the tool description still explains the opt-in and the `EOFF` result.

### The tool owns its chat

The tool takes no `chatId` argument. Which chat it acts on is ambient server context (the running chat), never model input, so the model cannot retarget another conversation by guessing an id. A call that still passes one is refused with `EBADINPUT` rather than silently redirecting, and a call outside any chat fails with a clear error instead of picking a chat.

### Subagents use their own folder

A delegated run gets independent working-folder state rather than changing the parent chat's. The run starts in whatever folder the parent chat is using, and a `change_working_folder` call from inside the run switches the run alone. Siblings share the same starting directory unless they explicitly select different existing folders; separate state does not automatically create isolated checkouts.

Inside a run the `directory` argument means the same thing it does for a chat — an existing folder — but it resolves against the folder the run **started** in, not the project root and not the run's current folder. A fixed anchor is what keeps one argument meaning one folder; resolving against the current folder would make `sub-checkout` mean `sub-checkout` on the first call and `sub-checkout/sub-checkout` on the next. Omitting `directory` (or passing `""`, `false`, or `null`) returns the run to the folder it started in. The accepted forms differ from a chat's — a run returns to its start folder rather than creating a workspace — but both paths refuse the same non-string values with the same wording, so `true` fails identically inside and outside a run.

A run never creates a folder: `created` is always `false` for it, and preparing a checkout stays a separately authorized shell call. There is no default-workspace branch inside a run, because a run already has a folder to work in and `.mouaif/workspaces/<chatId>` names a chat, not a run.

A run's folder is live process state, not chat metadata: it belongs to the run, is dropped when the run settles, and never appears in chat storage. The tool's approval card names the run and the parent chat it was delegated from, and describes the effect as applying to the run, because the parent conversation's folder is untouched.

Permissions, approval decisions, pending-request recovery, cancellation, tasks and tools such as `get_chat` and `list_chat_attachments` keep using the real parent chat. `attach_chat_image` reads from the run's current folder and saves into the target chat. If the selected parent folder is missing, delegation fails before launching the nested model instead of silently running in the original project. A folder that disappears during a run also fails on the next local-tool call.

### Arguments

| Argument | Meaning |
| --- | --- |
| `directory: "packages/my-feature"` | Use an existing directory relative to the original project, not the previous working folder. |
| `directory: "/absolute/path"` | Use an existing absolute directory within the normal filesystem boundary. |
| `directory: ""` or `"."` | Return to the original project folder. |
| `directory` omitted, or `directory: false` / `directory: null` | Create or reuse `<project>/.mouaif/workspaces/<chatId>`. Requires _Allow automatic workspaces_; otherwise the call fails with `EOFF` and nothing is created. |
| `directory: true` | Refused with `EBADINPUT`: `true` is not a directory. |

Example tool arguments:

```json
{}
```

```json
{ "directory": "packages/my-feature" }
```

The **Change working folder** approval tells you which chat will work in the shown folder and that files read or edited and commands run for it will use that location. It says **Use a different folder**, **Return to the project folder**, or **Use a separate folder**. For a separate folder, it explains that a newly created folder starts empty and project files are not copied. Chat titles appear before IDs; the folder and project paths remain visible. The same details survive reloading a pending approval; previewing the request does not create anything.

For existing directories, the approval and any allowlist match use the **real destination**, resolving symbolic links rather than showing only an alias. The tool resolves it again before changing the folder. If the destination changed while approval was pending, the call fails with `ESTALE_PATH` and keeps the current folder; request a fresh approval. Missing or invalid destinations fail validation instead of producing a misleading approval.

The result reports `workingDir`, `created`, and the updated chat. The legacy `branch` field remains `null` for compatibility; the tool does not inspect Git state. The current folder also appears below the chat title and in `get_chat`. Shell and file operations use the new folder immediately, including subsequent calls in the same turn, later turns, and delegated subagent tools. Composer `@shell` uses the same folder. `attach_chat_image` reads relative image paths from the calling chat's working folder while saving attachments to the target chat in the original project.

### Automatic workspaces

Creating the default workspace is controlled by the **Allow automatic workspaces** switch in Settings → Project → **General**, with an app-level default in Settings → App defaults → Chat defaults. The option is stored as `autoWorkspace` (in `.mouaif.json`, or the app store when the project is DB-backed). It is `false` everywhere by default, and the resolved value is defaults → app → project, so either level can turn it on.

| `autoWorkspace` | `change_working_folder` with no `directory` |
| --- | --- |
| off (default) | Fails with `EOFF`, referring the user to the switch. Nothing is created, and the chat's folder is unchanged. |
| on | Creates an empty `<project>/.mouaif/workspaces/<chatId>` or reuses the existing directory without changing its contents. |

Explicit `directory` strings are unaffected: selecting an existing folder or resetting to the project root always works, on or off, and never creates anything. An unreadable or corrupt project file counts as off — a configuration error is never a reason to write to the user's checkout.

The advertised `directory` type is the union `["string","boolean","null"]`, and the accepted values are exactly `string`, `false` and `null`. `true` passes the type check, so the tool refuses it with `EBADINPUT` (`true is not a directory`) instead of treating it as a path — the schema cannot express "only `false`", and a silently ignored argument would be worse than a typed error. The tool description and the [mouaif tool table](./mouaif-tool.md) list the same three forms.

### Directory creation

All projects, including Git repositories with or without commits, receive an empty folder:

```text
<project>/.mouaif/workspaces/<chatId>
```

- Git does not need to be installed. No repository inspection, branch creation, checkout, copying, merging, or cleanup command runs inside this tool.
- Repeating the default call reuses an existing directory without resetting its contents. An existing worktree prepared outside the tool continues to work. Files and symlink targets are rejected rather than replaced.
- Existing workspace parents must not be symlinks. Failed directory creation removes only newly created empty folders; pre-existing work survives. A request cancelled before execution creates nothing.
- Add `.mouaif/` to the project's `.gitignore` if you do not want workspace contents offered for staging.

### Git setup is a prompt workflow

The Average and Extensive coding prompts tell the assistant to inspect the original repository and existing workspace before using separately authorized shell calls to create or reuse a worktree from committed `HEAD` on a unique branch. It then selects that existing folder with `change_working_folder`. A newly created default folder is empty, **not a checkout**, so the assistant must prepare it before implementation needs source files. The Very small prompt states that the directory tool never runs Git; the Chat profile remains empty.

Git setup respects shell authorization and denied operations. Uncommitted and untracked files, ignored dependencies, and build output are not copied by a worktree operation; preserve unrelated work and get approval for dependency installation. Switching folders, resetting to the project, or deleting a chat never removes a workspace. Merging and cleanup remain separate operations, never directory-tool side effects.

## Scope and safety

- Chat storage, models, settings, permissions, agent instructions, skills, tags, traces, and MCP connections remain in the original project. Project redaction rules continue to apply to workspace-relative reads and searches. This is not a security sandbox.
- Missing or removed working folders fail instead of silently sending tools back to the original project.
- Selected run folders and resets enforce the same home-directory boundary as a chat, including when a directory is replaced by a symbolic link during the run. Existing temporary projects inherited outside home retain their local-tool sandbox; selecting another directory explicitly uses the normal home guard. `MOUAIF_ALLOW_ANY_ROOT=1` remains the explicit opt-out.
- Subagents get independent folder state. A delegated run starts in the parent chat's folder, and `change_working_folder` called by a subagent moves **that run only** — the parent and siblings keep their folders. Parallel delegates still share one tree until they select different directories. Run folders live for the run: when it finishes, its folder is forgotten, and a stale run id fails instead of falling back to the project. Already-running operations keep their existing directory.
- Persistent project CLI sessions, editor browsing, and the Git UI remain project-scoped.
- The existing chat APIs expose `workingDir`. Composer shell requests continue taking the original `projectDir` and `chatId`; no new REST endpoint is needed.
