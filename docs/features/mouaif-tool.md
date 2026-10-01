# mouaif tool

## Overview

The `mouaif` tool is one native tool that lets the assistant manage mouaif itself: this project's chats, image attachments, app and project settings, and the registered project list. It is a single tool with an `action` argument instead of one tool per operation, so the whole surface costs one spec in the request and the `very-small` prompt profile can compact it away.

## Usage

Ask for it in a normal sentence — the model picks the action:

```text
Create a chat called "Changelog v2" and put "draft the release notes" in its draft.
List my last few chats and tell me which model each one uses.
Attach docs/features/images/editor.png to this chat's draft.
Search my chats for "webpreview" and summarize what changed.
What is my default prompt size, and switch this project to agentFiles off.
```

### Actions

| Action | What it does |
| --- | --- |
| `list` | List this project's chats, newest first (`limit`, default 20, max 100). |
| `get` | Read one chat (`chatId`). `includeMessages: true` adds the last `messageLimit` messages (default 10, max 50). |
| `create` | Create a chat. `title` names it, `topic` seeds its composer draft, `providerId` + `modelId` pick its model. Returns the chat plus a `#/chat/<id>` link. |
| `update` | Change `title`, `draft`, `promptId`, `promptSize`, `providerId`, or `modelId` on an existing chat. |
| `delete` | Delete a chat and its transcript. Requires `confirm: true`. |
| `search` | Search titles, drafts, and message text (`query`). |
| `attach` | Put an image from the project into a chat: `path` is project-relative, `target` is `draft` (default — the composer holds it until the user presses send) or `message` (appends a real user message carrying the image, with optional `content`). |
| `list_attachments` | Show the images a chat holds, split into draft and message attachments. |
| `settings_get` | Read settings. `scope` is `app` (default) or `project`; `keys` narrows the result. |
| `settings_update` | Merge `patch` into the chosen scope; `unset` removes keys (project scope). Defaults to the project scope. |
| `project_list` | List the registered projects (id, name, path, cost). |
| `info` | Report the mouaif feature state — the same report the shipped `list_features` tool returns — plus this tool's own action table. |

### Where the model's data comes from

`attach`, `get`, and `info` default `chatId` to the chat the model is running in, so "attach this screenshot" needs no id. Every other action needs an explicit `chatId` — the tool never guesses between chats.

`attach` accepts only images (`png`, `jpeg`, `webp`, `gif`), because that is the only attachment the chat store understands. It reads the file with the file editor's boundary (the user home, or anywhere with `MOUAIF_ALLOW_ANY_ROOT=1`), so a path outside it fails with `EOUTSIDE_HOME` exactly like `read_file`.

### Authorization

The tool is one native authorization family, `mouaif`, gated the same way as Shell, File tools, and Web preview:

- **Settings → Project → Tools → mouaif app** — Off / Ask / Allow for the project.
- **Chat → Tools card** and the composer tools popup — the same segments, scoped to that chat.
- `off` hides the tool spec entirely; the model never pays tokens for it.
- `ask` shows the usual authorization card before the call runs.
- Per-chat overrides beat project settings, which beat app settings.

### Errors

Failures come back as a typed envelope the model can act on:

```json
{ "ok": false, "code": "ENOTFOUND", "message": "chat not found: 3e6fabe3" }
```

| Code | Meaning |
| --- | --- |
| `EBADINPUT` | A missing or invalid argument (unknown action, unknown model, unknown profile, no chat, `apiKey` in a patch). |
| `ENOTFOUND` | The chat does not exist. |
| `ECONFIRM` | `delete` was called without `confirm: true`. The result also reports the title and message count that would be lost. |
| `ENOTIMAGE` / `EBINARY` | `attach` was pointed at something that is not a readable image. |
| `ETOOLARGE` | The image is too large, or the draft already holds 8 images. |
| `EOUTSIDE_HOME` | The path escaped the file boundary. |
| `ETOOL_DISABLED` | The `mouaif` family is `off`. |

