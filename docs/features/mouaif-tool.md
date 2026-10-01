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
| `list` | List this project's chats, newest first, with bounded draft previews (`limit`, default 20, max 100). |
| `get` | Read one chat (`chatId`). `includeMessages: true` adds the last `messageLimit` messages (default 10, max 50). |
| `create` | Create a chat. `title` names it, `topic` seeds its composer draft, `providerId` + `modelId` pick its model. Returns the chat plus a `#/chat/<id>` link. |
| `update` | Change `title`, `draft`, `promptId`, `promptSize`, `providerId`, or `modelId` on an existing chat. |
| `delete` | Delete a chat and its transcript. Requires `confirm: true`. |
| `search` | Search titles, drafts, and message text (`query`). Results retain `matchField` and a bounded matching `snippet`. |
| `attach` | Put an image from the project into a chat: `path` is project-relative, `target` is `draft` (default — the composer holds it until the user presses send) or `message` (appends a real user message carrying the image, with optional `content`). |
| `list_attachments` | Show draft and message image names/types, not pixels. Scans the newest 200 messages by default; follow `nextBeforeSeq` with `beforeSeq` to retrieve older images. |
| `settings_get` | Read settings. `scope` is `app` (default) or `project`; `keys` narrows the result. |
| `settings_update` | Merge `patch` into the chosen scope; `unset` removes keys (project scope). Defaults to the project scope. |
| `project_list` | List the registered projects (id, name, path, cost). |
| `info` | Report the mouaif feature state, including the running chat's effective tool permissions — the same report the shipped `list_features` tool returns — plus this tool's own action table. |

### Where the model's data comes from

`get`, `attach`, and `list_attachments` default `chatId` to the chat the model is running in, so "attach this screenshot" needs no id. `update` and `delete` require an explicit `chatId`; other actions do not target an individual chat.

`list_attachments` scans a bounded message page, not the entire transcript. Set `limit` to 1–200 messages per page. When `nextBeforeSeq` is a number, pass it as `beforeSeq` on the next call; keep paging even if a page contains no images. `nextBeforeSeq: null` means no older messages remain. Draft images are included on every page, and image bytes are never returned.

Successful changes to the mounted chat refresh its title, model picker, prompt, and composer draft/images without reopening it. The same refresh applies when following a turn from another tab or recovering a dropped stream. A late refresh cannot overwrite a different chat or text/images the user edited while the request was pending.

A project model can infer its provider when creating a chat. A live-catalog model needs `providerId`; selections use the same resolver as sending a chat turn. Validation happens before creation, so a rejected model never leaves a blank chat. On update, `modelId: ""` clears the model/provider choice, `promptId: ""` detaches the prompt, and an unknown prompt is rejected.

`attach` accepts only images (`png`, `jpeg`, `webp`, `gif`), because that is the only attachment the chat store understands. It reads the file with the file editor's boundary (the user home, or anywhere with `MOUAIF_ALLOW_ANY_ROOT=1`), so a path outside it fails with `EOUTSIDE_HOME` exactly like `read_file`.

### Where it appears

The tool shows up as **two categories** in the tools tree (Settings → Project → Tools, the chat Tools card, and the composer tools popup), each listing its own actions as child rows:

| Category row | Actions (child rows) |
| --- | --- |
| **Chats** | `list` `get` `create` `update` `delete` `search` `attach` `list_attachments` |
| **mouaif** | `settings_get` `settings_update` `project_list` `info` |

**Each action checkbox is independent.** Checking `list chats` does not select `delete a chat`, settings actions, or any sibling. A category checkbox selects only that category's actions; a partially selected category shows a mixed checkmark.

The model still receives one `mouaif` function, whose `action` enum contains only selected, permitted actions. Calls to unchecked actions are rejected with `ETOOL_DISABLED`, including stale or forged calls. Existing chats with a `mouaif` selection continue to select every action until edited.

In project settings, action checkboxes write separate `mouaif:<action>` permission entries. In a chat, they write separate selection keys and restore **Ask** when needed. The Off / Ask / Allow segments remain the shared `mouaif` family gate; **Off** hides all actions. The two category segments use independent radio-group names while displaying the same family mode.

The category rows are built from `GROUPS` in [src/tools/mouaif.js](../../src/tools/mouaif.js), whose `actions` list is derived from the `ACTIONS` area table — adding an action puts it under its area's category with no second edit.

### Authorization

The tool is one native authorization family, `mouaif`, gated the same way as Shell, File tools, and Web preview:

- **Settings → Project → Tools** — Off / Ask / Allow for the project, on either category row.
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
| `EBADINPUT` | A missing or invalid argument (wrong type, unknown argument/action/model/prompt/profile, no chat, invalid attachment target, empty patch, `apiKey` in a patch). |
| `ENOTFOUND` | The chat does not exist. |
| `ECONFIRM` | `delete` was called without `confirm: true`. The result also reports the title and message count that would be lost. |
| `ENOTIMAGE` / `EBINARY` | `attach` was pointed at something that is not a readable image. |
| `ETOOLARGE` | The image is too large, or the draft already holds 8 images. |
| `EOUTSIDE_HOME` | The path escaped the file boundary. |
| `ETOOL_DISABLED` | The `mouaif` family is `off`. |

### Settings safety

Both settings scopes redact provider/model credentials. Credential writes, including keys inside `providers` or `models`, must go through Settings → Providers instead. Round-tripping redacted settings preserves existing credentials. Project `unset` runs after `patch`, so a key present in both is removed.

