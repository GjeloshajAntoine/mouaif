# Native chat and app tools

## Overview

Twelve ordinary native tools let the assistant manage this project's chats, image attachments, app and project settings, and the registered project list. Each tool has its own function name, argument schema, checkbox, and Off / Ask / Allow permission—just like the other native tools. There is no `mouaif` function or `action` argument.

## Usage

Ask in a normal sentence—the model chooses the appropriate tool:

```text
Create a chat called "Changelog v2" and put "draft the release notes" in its draft.
List my last few chats and tell me which model each one uses.
Attach docs/features/images/editor.png to this chat's draft.
Search my chats for "webpreview" and summarize what changed.
What is my default prompt size, and switch this project to agentFiles off.
```

### Tools

| Tool | What it does |
| --- | --- |
| `list_chats` | List this project's chats, newest first, with bounded draft previews (`limit`, default 20, max 100). |
| `get_chat` | Read one chat (`chatId`). `includeMessages: true` adds the last `messageLimit` messages (default 10, max 50). |
| `create_chat` | Create a chat. `title` names it, `topic` seeds its composer draft, `providerId` + `modelId` pick its model. Returns the chat plus a `#/chat/<id>` link. |
| `update_chat` | Change `title`, `draft`, `promptId`, `promptSize`, `providerId`, or `modelId` on an existing chat. |
| `delete_chat` | Delete a chat and its transcript. Requires `confirm: true`. |
| `search_chats` | Search titles, drafts, and message text (`query`). Results retain `matchField` and a bounded matching `snippet`. |
| `attach_chat_image` | Put an image from the project into a chat: `path` is project-relative, `target` is `draft` (default — the composer holds it until the user presses send) or `message` (appends a real user message carrying the image, with optional `content`). |
| `list_chat_attachments` | Show draft and message image names/types, not pixels. Scans the newest 200 messages by default; follow `nextBeforeSeq` with `beforeSeq` to retrieve older images. |
| `get_settings` | Read settings. `scope` is `app` (default) or `project`; `keys` narrows the result. |
| `update_settings` | Merge `patch` into the chosen scope; `unset` removes keys (project scope). Defaults to the project scope. |
| `list_projects` | List the registered projects (id, name, path, cost). |
| `get_app_info` | Report the mouaif feature state, including the running chat's effective tool permissions — the same report the shipped `list_features` tool returns — plus the list of native chat/app functions. |

### Where the model's data comes from

`get_chat`, `attach_chat_image`, and `list_chat_attachments` default `chatId` to the current chat. `update_chat` and `delete_chat` require an explicit `chatId`; the other tools do not target one chat.

`list_chat_attachments` scans a bounded message page, not the entire transcript. Set `limit` to 1–200 messages per page. When `nextBeforeSeq` is a number, pass it as `beforeSeq` on the next call; keep paging even if a page contains no images. `nextBeforeSeq: null` means no older messages remain. Draft images are included on every page, and image bytes are never returned.

Successful changes to the mounted chat refresh its title, model picker, prompt, and composer draft/images without reopening it. The same refresh applies when following a turn from another tab or recovering a dropped stream. A late refresh cannot overwrite a different chat or text/images the user edited while the request was pending.

A project model can infer its provider when creating a chat. A live-catalog model needs `providerId`; selections use the same resolver as sending a chat turn. Validation happens before creation, so a rejected model never leaves a blank chat. On update, `modelId: ""` clears the model/provider choice, `promptId: ""` detaches the prompt, and an unknown prompt is rejected.

`attach_chat_image` accepts only images (`png`, `jpeg`, `webp`, `gif`), because that is the only attachment the chat store understands. It reads the file with the file editor's boundary (the user home, or anywhere with `MOUAIF_ALLOW_ANY_ROOT=1`), so a path outside it fails with `EOUTSIDE_HOME` exactly like `read_file`.

### Where it appears

The tools appear in two visual categories in Settings → Project → Tools, the chat Tools card, and the composer tools popup:

| Category | Native functions |
| --- | --- |
| **Chats** | `list_chats`, `get_chat`, `create_chat`, `update_chat`, `delete_chat`, `search_chats`, `attach_chat_image`, `list_chat_attachments` |
| **mouaif** | `get_settings`, `update_settings`, `list_projects`, `get_app_info` |

Every child checkbox selects its own function. A category checkbox toggles only its children; a partial selection shows a mixed checkmark. Every child has its own permission control. Categories do not share or override permissions.

For example, this chat selects just two ordinary functions:

```json
{
  "tools": ["list_chats", "get_settings"],
  "toolAuth": {
    "native": {
      "list_chats": { "mode": "ask" },
      "get_settings": { "mode": "allow" }
    }
  }
}
```

A one-time startup migration converts older `mouaif` and `mouaif:<action>` selections, permissions, prompt presets, and agent allowlists to native function names. Stored Off/Ask/Allow choices are preserved; the running tool paths have no legacy-name exception.

### Authorization

Each function uses the normal native-tool authorization gate independently:

- **Settings → Project → Tools** — Off / Ask / Allow for each function, project-wide.
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
| `ECONFIRM` | `delete_chat` was called without `confirm: true`. The result also reports the title and message count that would be lost. |
| `ENOTIMAGE` / `EBINARY` | `attach_chat_image` was pointed at something that is not a readable image. |
| `ETOOLARGE` | The image is too large, or the draft already holds 8 images. |
| `EOUTSIDE_HOME` | The path escaped the file boundary. |
| `ETOOL_DISABLED` | The function's permission is `off`. |

### Settings safety

Both settings scopes redact provider/model credentials. Credential writes, including keys inside `providers` or `models`, must go through Settings → Providers instead. Round-tripping redacted settings preserves existing credentials. Project `unset` runs after `patch`, so a key present in both is removed.

