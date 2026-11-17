# Extensions

## Overview

An extension packs several things into **one file**, `<id>.mouaif-extension.json`: [hooks](hooks.md), a small UI that shows in the chat or in Settings, and optionally the MCP server behind both. Think of it as "an MCP server plus a manifest": the server's tools are the extension's backend, its `ui://` resources are its UI, and its hooks wire it into the chat.

- One import, one permission screen, one switch to turn it off.
- The UI runs sandboxed, like MCP Apps, and can only do what its permissions allow.
- Hooks and the server run on this computer with your permissions, like any hook or MCP server you add yourself.

## Usage

Open **Settings → App defaults → Extensions** (`#/settings/extensions`).

- **Hooks** at the top opens the [hooks](hooks.md) you add yourself (`#/settings/extensions/hooks`): the list, the editor, **Run hooks** and recent runs. The row shows how many there are and whether they are paused.

- **Import file** reads a `.mouaif-extension.json` file and shows the permission screen. It lists what the extension's UI may do, the MCP server it uses or registers, every hook as written, and where its UI appears. The extension stays **off** until you tap **Turn on**. **Not now** keeps it imported but off, and **Remove** deletes it.
- Each installed extension has these controls:
  - an on/off switch,
  - **Details** (the same summary),
  - **Off in this project**, which turns it off for the active project only,
  - **Export**, which downloads the same file back,
  - **Delete** (tap twice).
- Importing a file whose `id` is already installed replaces it and turns it off again, so you see the new content before it runs.

### Project extensions

A repository can ship extensions as `.mouaif/extensions/<id>.mouaif-extension.json`. They behave like [project hooks](hooks.md#project-hooks):

- They stay **off** until you review them. The **Project … off** bar in the project's chats and **Settings → Extensions → This project** both offer **Trust and turn on**.
- Trust is tied to a fingerprint (a sha256 hash) of the file and of every project script its command hooks run. Any change turns the extension off again, from the next hook on.
- A project extension can use an MCP server the project already configures (`server.ref`), but cannot register one.
- Once you trust it, a project extension with the same `id` as an installed one takes its place in that project. A file you haven't trusted (or that changed since) doesn't, so a repository can't switch off one of your extensions. The two keep separate storage.

### The file

```json
{
  "mouaifExtension": 1,
  "id": "ci-watch",
  "name": "CI watch",
  "version": "0.1.0",
  "description": "Shows the branch's CI state and adds it to prompts.",
  "server": { "ref": "github-ci" },
  "permissions": ["chat.read", "composer.insert"],
  "hooks": [
    { "id": "ci-context", "event": "prompt.submit", "handler": { "kind": "mcp", "tool": "ci_summary" } },
    { "id": "no-force-push", "event": "tool.before", "match": { "tool": ["shell"], "argText": "push.*--force" },
      "handler": { "kind": "command", "shell": "bash", "script": "echo 'No force pushes.' >&2; exit 2" }, "failClosed": true }
  ],
  "ui": [
    { "id": "ci-dock", "slot": "chat.dock", "title": "CI", "resourceUri": "ui://ci-watch/dock" },
    { "id": "ci-help", "slot": "chat.sheet", "title": "CI help", "html": "<!doctype html><p>…</p>" }
  ]
}
```

| Key | Holds |
| --- | --- |
| `mouaifExtension` | `1` |
| `id` | lowercase letters, digits and `-`, up to 40; one extension per id |
| `name`, `version`, `description` | shown in Settings (`version` is informational) |
| `server` | `{ "ref": "<server id or slug>" }`: an MCP server set up in Settings → MCP (or the project's `.mcp.json`). Or an inline server (`name`, then `command` + `args` + `env`, or `url`), registered app-wide while the extension is on and removed when it is turned off or deleted. |
| `permissions` | what its UI may do: `chat.read` (read the chat's recent messages as text), `composer.insert` (put text in your message box, never send), `chat.message` (send a message), `storage` (its own 64 KB of settings), `model.context` (add context the model sees on the next turns) |
| `hooks` | hook entries as in [Hooks](hooks.md). One more kind, `{ "kind": "mcp", "tool": "<name>" }`, calls a tool on the extension's server with the event as its arguments and reads the answer from `structuredContent` (or the first text block). |
| `ui` | surfaces: `id`, `slot` (`chat.dock`, `chat.sheet`, `settings.page`, `tool.renderer` with `match.tool`, `project.card`, `composer.action` with an optional `command`, `message.action` with an optional `match.role`, `files.action`, `git.action`, `inspector.panel`, `app.panel`, `app.route`, `chat.list.action`), `title`, and `resourceUri` (a `ui://` resource on the server) or `html` (a single-file page, up to 512 KB). Optional `collapsed` (`chip` or `open`), `events` and `shortcut` (see [Shortcuts](#shortcuts)). |

The whole file is at most 1 MiB. Keys mouaif does not know are kept, so a newer file still imports, and **Export** writes the file back unchanged plus `exportedAt`.

### Where its UI shows

Each `ui` entry is a **view**: a small web page (an MCP App) that mouaif runs sandboxed in a slot. The page has its own origin, no access to mouaif's page, cookies or session, and only the network its resource allows (none for inline `html`).

- **`chat.dock`**: a bar above the message box in every chat where the extension is on, showing the view's title and a badge the view can set. **Open** shows the view under the bar, up to 30% of the screen height and taller if you drag its corner. The bar remembers whether you left it open, and `"collapsed": "open"` starts it open.
- **`chat.sheet`**: an entry in the chat's file menu (next to custom actions) that opens the view in a bottom sheet. The view runs while the sheet is open.
- **`tool.renderer`** (with `"match": { "tool": ["shell", "mcp__github__*"] }`): replaces the body of matching tool cards, built when you expand the card. The view receives the call's arguments and result through the standard MCP Apps notifications, so an existing MCP App works as a renderer unchanged. A native tool's JSON result arrives as `structuredContent`. The ordinary result stays under **Raw result**. A renderer sees the arguments and results of the tools it matches, and the permission screen lists those tools (or says **Every tool call** for `*`).
- **`settings.page`**: a page at `#/settings/extensions/<id>/<surface>`, linked from the extension's card in Settings → Extensions. It runs in the active project, with no chat.
- **`project.card`**: a chip under the chats of every project where the extension is on. Tapping it opens the view in a sheet, with no chat.
- **`composer.action`**: a small button in the message box, next to the image and mic buttons, that opens the view in a sheet. With `"command": "ticket"`, sending `/ticket` alone opens it instead of sending a message. A command belongs to the first active extension that claims it. Another extension that claims the same command keeps its button but gets no command.
- **`message.action`** (with `"match": { "role": "assistant" }`, the default, or `"user"`): a puzzle button under each saved message of that role. One action opens directly, several show a short menu. The view opens in a sheet and gets the message as `structuredContent.mouaif`: `{ type: "message", role, messageSeq }`, plus the message's `text` (up to 32 KB) when the extension has `chat.read`.
- **`files.action`**: a puzzle button in the file editor's header, just before Close. The view opens in a sheet that runs in the project, with no chat.
- **`git.action`**: the same, in the Git sheet's header.
- **`inspector.panel`**: the same, in the Inspector's header while a page is attached.
- **`app.panel`**: a small puzzle button at the right of the app header, available on every screen, for the active project and with no chat.
- **`app.route`**: a full page at `#/ext/<id>/<surface>`, for the active project and with no chat. The first two get a tab in the bottom bar (puzzle icon, the view's title), and every page is also listed in the app header's puzzle menu.
- **`chat.list.action`**: a puzzle button on each chat row of the Chats list. The view opens in a sheet bound to that chat, so `chat.recent`, `message.annotate` and events work there. It gets `structuredContent.mouaif`: `{ type: "chat", chatId, title }`.
- When several views share one of these buttons, it opens a menu. When none are active, it isn't shown.
- Only **two** docked views or renderers run at once in a tab: opening a third closes the one you used least recently (a renderer then shows **Show …** to bring it back). A view also closes when the tab is hidden and offers **Retry** when you come back. Each view is a browser process, and mouaif's host is small.
- Views load through the app's own port, so a Docker install has nothing extra to publish.
- `?safe` in the address shows no extension views.

A view receives the active theme through the MCP Apps host context: the standard style variables (`--color-background-primary`, `--color-text-primary`, `--font-sans`, `--border-radius-md`, …) mapped from the mouaif theme, plus `theme` (`light` or `dark`, from the theme's background). It is updated when you switch themes. `hostContext.mouaif` carries `slot`, `extensionId`, `surfaceId`, `chatId`, `projectName` and the raw mouaif tokens (`--bg`, `--surface`, `--fg`, `--accent`, …).

An inline `html` view gets the MCP Apps SDK already connected, as `window.mouaifApp` (`window.mouaifAppReady` resolves when it is): call `getHostContext()` and set `onhostcontextchanged` on it.

### What a view can do

A view can call its server's tools that are visible to apps, through the usual approval card in its chat, and send a message in the chat only with the `chat.message` permission.

It can also call **host tools**: ordinary MCP `tools/call` requests whose name starts with `mouaif/`. Only extension views can call them, never a tool result's app, and each checks the extension's permissions:

| Tool | Needs | Does |
| --- | --- | --- |
| `mouaif/chat.recent` `{ limit? }` | `chat.read` | The chat's last messages (up to 50), role and text only, at most 32 KB |
| `mouaif/composer.insert` `{ text }` | `composer.insert` | Puts text in the message box at the cursor, up to 8 KB. It is never sent: you send it. |
| `mouaif/chat.badge` `{ text, tone? }` | none | Sets the dock chip's badge (up to 8 characters, empty clears it), tone `info`, `ok`, `warn` or `error` |
| `mouaif/chat.open_sheet` `{ surfaceId }` | none | Opens one of the same extension's sheets |
| `mouaif/message.annotate` `{ messageSeq, text, tone?, title? }` or `{ clearAll: true }` | none | Shows a small badge (up to 24 characters, tone `info`, `ok`, `warn` or `error`, `title` as its tooltip) in the head of a saved message of the chat. Empty `text` removes this view's badge from that message, and `clearAll` removes all of its badges. Badges live in the tab's memory: a reload clears them. `chat.recent` returns each message's `seq` to aim with. |
| `mouaif/settings.get` `{ key? }` | `storage` | Reads the extension's own stored values (one key or all) |
| `mouaif/settings.set` `{ key, value }` | `storage` | Stores a JSON value (`null` deletes it). This is the extension's own store, 64 KB per extension, not mouaif's settings, and it is deleted with the extension. A project extension has its own store, even when it shares an app extension's id. |

In an inline view: `await window.mouaifApp.callServerTool({ name: 'mouaif/chat.badge', arguments: { text: '2 fail', tone: 'error' } })`.

### Shortcuts

A `ui` entry of a `chat.sheet`, `composer.action`, `app.panel` or `app.route` view can set `"shortcut": "mod+shift+k"`: `mod` (Ctrl, or Cmd on Apple devices) and/or `alt`, optional `shift`, then one letter or digit. It is matched on the physical key, so it works with any keyboard layout.

- `app.route` goes to the page, and `app.panel` opens its sheet, from any screen.
- `chat.sheet` and `composer.action` open their sheet only in an open chat.
- The first active extension that claims a shortcut keeps it, and later ones get none. The permission screen shows each shortcut, and the menus show it as a tooltip.

### Context for the model

A view of an extension with the `model.context` permission can set context the model sees on the next turns, with the standard `ui/update-model-context` request (`await window.mouaifApp.updateModelContext({ content: [{ type: 'text', text: 'Current ticket: #142 …' }], structuredContent: { ticket: 142 } })`).

- Each view has one entry per chat, and the latest update replaces it. It holds text up to 4 KB plus JSON up to 4 KB. A chat takes at most 4 views and 16 KB, and an entry expires 2 hours after its last update. Sending empty content clears the view's entry.
- Setting context never starts or interrupts a turn. New or changed context goes with your **next prompt**, as a labelled block the model is told to treat as data from the view (`<app-context extension="…" view="…">`). It is stored with that prompt, so later turns and a resumed chat see exactly what the model saw, and unchanged context is not sent again.
- An **App context** bar above the message box shows each entry exactly as the model receives it, whether it is sent yet, and **Clear** / **Clear all**. Clearing stops it from being sent again; the model keeps what it already received. Under the prompt it was sent with, it appears in the **Added by extension views** block.
- Context lives in memory only: a restart forgets it. Closing the view does not clear it, so a sheet can set the current ticket and close. Turning the extension off or deleting the chat does clear it.
- Nothing goes into the system prompt, and a view cannot pick the chat or the model.

### Events

A view that lists `"events": ["turn.start", "turn.end", "tool.after", "model.change"]` in its `ui` entry receives those chat events while it is open (nothing is queued for a closed view). They arrive as a tool-result notification whose `structuredContent` is `{ "mouaif": { "type": "event", "event": "turn.end", "payload": { … } } }`. The payloads are:

- `turn.start`: `{ model }`
- `tool.after`: `{ tool, ok, callId }`, plus the capped `result` with `chat.read`
- `turn.end`: `{ toolCount }`, plus the answer `text` with `chat.read`
- `model.change`: `{ from, to }`, sent before `turn.start` when the turn uses a different model than the chat's previous answer

Events reach every open tab of the chat. mouaif only sends them while some active view asked for them.

### Order

An extension's hooks run under the id `<extension>/<hook>` (shown that way on tool cards). The full order is:

1. app hooks,
2. installed extensions,
3. project hooks,
4. project extensions,
5. the chat's own hooks.

**Run hooks** in Settings → Extensions → Hooks and `MOUAIF_NO_HOOKS=1` cover extension hooks too. A command hook from an extension sees `MOUAIF_EXTENSION_ID`.

For the module surface, storage and REST routes, see the implementation notes that ship with the repository (`docs/agent/features/extensions.md`).

## Related

- [Hooks](hooks.md): the hook entries an extension carries.
- [MCP Apps](mcp-apps.md): the sandbox an extension's UI runs in.
