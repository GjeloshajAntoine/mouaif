# Native chat and app tools

## Overview

Twenty-two ordinary native functions in two families let the assistant manage this project's chats and working folders, model discovery and background turns, image attachments, app and project settings, the registered project list, and the app itself (restart, feature report): **15 in the Chats family** and **7 in mouaif**. Each tool has its own function name, argument schema, checkbox, and Off / Ask / Allow permission—just like the other native tools. There is no `mouaif` function or `action` argument. Two more are advertised without a row of their own: `activate_skill`, gated by the Skills switches in **Settings → Project**, and the `mcp__<server>__<tool>` specs, gated through `.mcp.json`. See [Tool groups](./tool-groups.md) for the complete native surface.

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
| `update_chat` | Change `title`, `draft`, `promptId`, `promptSize`, `providerId`, or `modelId` on an existing chat. Model changes apply to the next turn. |
| `change_working_folder` | Change a chat's shell/file working folder to an existing directory. `directory` is required: a project-relative or absolute path to a directory that already exists, or `""` (or `"."`) to return to the original project folder. `chatId` defaults to the calling chat. The tool never creates a folder and never runs Git, so prepare a checkout with an authorized shell command first. See [Chat working folders](./chat-working-folder.md). |
| `search_models` | Search saved project models and configured providers’ live chat catalogs; returns bounded `providerId` / `modelId` choices with pagination and per-provider failures. |
| `start_chat` | Send `content` to an existing `chatId` using its selected model and start a background response. Returns a chat URL without waiting for completion. |
| `delete_chat` | Delete a chat and its transcript. Requires `confirm: true`. Refuses the chat the turn is running in. |
| `search_chats` | Search titles, drafts, and message text (`query`). Results retain `matchField` and a bounded matching `snippet`. |
| `attach_chat_image` | Put an image from the project into a chat: `path` is relative to the calling chat's working folder (the project by default), `target` is `draft` (default — the composer holds it until the user presses send) or `message` (appends a real user message carrying the image, with optional `content`). |
| `list_chat_attachments` | Show draft and message image names/types and `imageRef` values, not pixels. Scans the newest 200 messages by default; follow `nextBeforeSeq` with `beforeSeq` to retrieve older images. |
| `get_settings` | Read settings. `scope` is `app` (default) or `project`; `keys` narrows the result. |
| `update_settings` | Merge `patch` into the chosen scope; `unset` removes keys (project scope). Defaults to the project scope. |
| `list_projects` | List the registered projects (id, name, path, cost). |
| `get_app_info` | Report the mouaif feature state, including the running chat's effective tool permissions — the same report the shipped `list_features` tool returns — plus the list of native chat/app functions. |
| `restart_app` | Gracefully relaunch the app worker from this chat, with an optional `reason`. The supervisor keeps running, so the port and terminal stay the same. See [Restart from chat](./chat-app-restart.md). |
| `list_features` | Describe every mouaif feature available in this project and its current on/off/ask state. Read-only metadata; it takes no arguments. |
| `ask_user` | Pause and ask the user a structured question with 2+ options. The user picks one and may always add a free-form note. Binary: Off / Ask only, because the answer cannot be predicted. See [Ask user tool](./ask-user-tool.md). |
| `task` | Create, update, track progress on, and list structured tasks with subtasks, to break complex work into pieces and show progress. Each task gets an auto-generated id. See [Task tool](./task-tool.md). |
| `report_progress` | Report real-time progress on a long-running operation, drawn as the chat's progress bar. Read-only UI metadata — answered without an approval card. See [Progress tool](./progress-tool.md). |
| `webpreview` | Refresh the user-facing preview of a URL in the debug Chrome the Inspector uses. `viewport` is a preset (`phone`, `phone+`, `tablet`, `laptop`) or `WIDTHxHEIGHT`; `mode: "live"` shows the interactive page instead of a screenshot. See [Web preview](./webpreview.md). |
| `group_cli` | Run a batch of up to 50 shell commands in one call and get every result, each with its own stdout, stderr, exit code and duration. An `async: true` entry starts in the background and names its log under `.mouaif/logs/`. See [Grouped CLI tool](./grouped-cli-tool.md). |

### Where the model's data comes from

`get_chat`, `change_working_folder`, `attach_chat_image`, and `list_chat_attachments` default `chatId` to the current chat. `update_chat`, `start_chat`, and `delete_chat` require an explicit `chatId`; the other tools do not target one chat.

See [Chat model tools](./chat-model-tools.md) for model search options and the search → create/update → start workflow. A background start uses the target chat's normal permissions, cancellation, live replay, and transcript persistence; a busy chat rejects the start without appending a message.

`list_chat_attachments` scans a bounded message page, not the entire transcript. Set `limit` to 1–200 messages per page. When `nextBeforeSeq` is a number, pass it as `beforeSeq` on the next call; keep paging even if a page contains no images. `nextBeforeSeq: null` means no older messages remain. Draft images are included on every page, and image bytes are never returned. Each entry has an `imageRef` for explicit selection in `subagent.images`. Message entries also carry `messageSeq`; draft references identify the image contents so reordering does not select a different image. References resolve only within the current chat, and removed/replaced images fail rather than falling back to another attachment.

Successful changes to the mounted chat refresh its title, model picker, prompt, and composer draft/images without reopening it. This includes tools called inside subagents: nested live results refresh immediately, and settled direct-dispatch or recovered results replay successful mutations even if the agent later failed. Nested call IDs deduplicate the live and settled copies. The same refresh applies when following a turn from another tab or recovering a dropped stream. A late refresh cannot overwrite a different chat or text/images the user edited while the request was pending.

A project model can infer its provider when creating a chat. A live-catalog model needs `providerId`; selections use the same resolver as sending a chat turn. Validation happens before creation, so a rejected model never leaves a blank chat. On update, `modelId: ""` clears the model/provider choice, `promptId: ""` detaches the prompt, and an unknown prompt is rejected.

Concurrent `attach_chat_image` calls merge into the latest saved draft after loading the image, so parallel subagents do not overwrite one another. The eight-image limit is checked at that merge; if only one slot remains, only one call succeeds. A chat deleted during image loading returns `ENOTFOUND` instead of reporting a phantom attachment.

`attach_chat_image` accepts only images (`png`, `jpeg`, `webp`, `gif`), because that is the only attachment the chat store understands. It reads the file with the file editor's boundary (the user home, or anywhere with `MOUAIF_ALLOW_ANY_ROOT=1`), so a path outside it fails with `EOUTSIDE_HOME` exactly like `read_file`.

### Where it appears

The tools appear in two families in Settings → Project → Tools, the chat Tools card, and the composer tools popup:

| Family (gate) | Native functions |
| --- | --- |
| **Chats** (`tools.chats`) | `list_chats`, `get_chat`, `create_chat`, `update_chat`, `change_working_folder`, `search_models`, `start_chat`, `delete_chat`, `search_chats`, `attach_chat_image`, `list_chat_attachments`, `ask_user`, `task`, `report_progress`, `webpreview` |
| **mouaif** (`tools.mouaif`) | `get_settings`, `update_settings`, `list_projects`, `get_app_info`, `restart_app`, `list_features`, `group_cli` |

The Chats family carries the app functions above *and* the four tools the model uses inside one chat: **Ask user** (`ask_user`, binary Off / Ask), **Task** (`task`), **Report progress** (`report_progress`) and **Web preview** (`webpreview`, see [Web preview](./webpreview.md)). They used to be rows of their own; a stored `tools.<leaf>` still works as that leaf's override.

The mouaif family also carries the tools that act on the app itself rather than on one project: **Restart app** (`restart_app`), **Feature report** (`list_features`) and the grouped CLI batch tool (`group_cli`, see [Grouped CLI tool](grouped-cli-tool.md)). They are leaves of this family now, so a family `Allow` — including one earned by choosing **Always allow** on any mouaif call — also covers an app restart and a batch of shell commands. Store `tools.restart_app` / `tools.list_features` / `tools.group_cli` to override one leaf on its own. `list_features` is read-only, so it is never shown an approval card; an `off` on the family or the leaf hides it from the model. `group_cli` runs commands, so it keeps the ordinary approval card and its card lists every command in the batch.

Every child checkbox selects its own function; a partial selection shows a mixed checkmark. The two families work exactly like **File tools**:

- the row's `Off / Ask / Allow` segment edits one gate — `tools.chats` or `tools.mouaif` — that covers every function in the family;
- in Settings → Project each function also has its own segment, which stores a per-function override (`tools.delete_chat`, …). A function `off` always wins; a family `allow` beats any other per-function value;
- a family `off` hides all of its functions from the model; it never touches the other family.

Per-function permissions saved before the families existed keep working: they are the per-function overrides.

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
| `EBADINPUT` | A missing or invalid argument (wrong type, unknown argument/action/model/prompt/profile, no chat, invalid attachment target, empty patch, `apiKey` in a patch, an app key outside the client allowlist, deleting the running chat). |
| `ENOTFOUND` | The chat does not exist. |
| `EALREADY_RUNNING` | `start_chat` targeted a chat whose response is already running. |
| `ECONFIRM` | `delete_chat` was called without `confirm: true`. The result also reports the title and message count that would be lost. |
| `ENOTIMAGE` / `EBINARY` | `attach_chat_image` was pointed at something that is not a readable image. |
| `ETOOLARGE` | The image is too large, or the draft already holds 8 images. |
| `EOUTSIDE_HOME` | The path escaped the file boundary. |
| `ETOOL_DISABLED` | The function's permission is `off`. |

### Settings safety

Both settings scopes redact provider/model credentials. Credential writes, including keys inside `providers` or `models`, must go through Settings → Providers instead. Round-tripping redacted settings preserves existing credentials, unless the entry's `baseUrl` changed: then the stored key is dropped, so a credential is never sent to a host it was not entered for. Project `unset` runs after `patch`, so a key present in both is removed.

App-scope writes accept only the keys `get_settings` can read back (the client settings allowlist); anything else is rejected rather than stored out of sight.

A write or `unset` that touches a permission key (`tools`, `mcp`, `authAccounts`, `authPending`) always shows the authorization card, even when `update_settings` is `allow` or granted for the session. The card summary lists the keys. This stops a model from raising its own tool permissions.

