# Custom prompts

## Overview

Custom prompts let you define reusable system messages that are prepended to every chat turn. Prompts can be configured at two scopes:

- **App defaults** — stored in the app SQLite database (`~/.mouaif/store.sqlite`) under `prompts`, available across all projects.
- **Project-specific** — stored in `<projectDir>/.mouaif.json` alongside other project settings, committed to version control. Project prompts take precedence over app prompts with the same ID.

The role is fixed to `system`: a custom prompt is always the opening system message of the turn, never an injected `user` or `assistant` message. Prepending a fake user/assistant message before the transcript would bias the conversation; if you need that, write it into the actual transcript.

A prompt can additionally define a **preset** (`preset.tools` + `preset.agentFiles` + `preset.skills`). A preset is the starting settings of a chat created from the prompt: the chat begins with those tools, and with agent files and skills on or off as the preset says. The chat's Tools card shows them, and you can change them there afterwards like any other chat setting. A preset never overrides the project's authorization gate (see [Chat integration](#chat-integration-presets) below).

When a chat is attached to a prompt it pins a **snapshot** of that prompt's title, text, and preset. The chat then sends the pinned copy on every turn, so editing the prompt later never rewrites a chat that already uses it — only chats attached afterwards see the new text (see [Prompt snapshots](#prompt-snapshots) below).

Each prompt also has a safe built-in icon (a set of hand-drawn, stroke-based SVG glyphs). The optional **Add to project card** setting exposes that icon as a one-tap new-chat action on every project card where the prompt is available.

## Usage

### Managing prompts (Settings UI)

Prompts can be managed from two locations in Settings:
1. **Settings → App defaults → Custom prompts** (`#/settings/prompts`): Manage global custom prompts that apply across all projects.
2. **Settings → This project → Custom prompts** (`#/settings/prompts?projectDir=...`): Manage project-specific prompts and view inherited app-wide prompts.

The **Prompt** picker lists every saved prompt (with a `preset` tag for ones that carry a tool/agent-file/skills preset; scope badges only appear on the project screen, where the two scopes are mixed, and are omitted on the single-scope App-defaults screen) plus a `+ New prompt` entry for a blank form. Below the saved prompts, a **Built-in** section lists the four prompt-size profiles (`Very small`, `Average`, `Extensive`, `Chat`, each tagged `built-in`, plus `on card` when pinned). Picking one opens it in the same editor — see [Built-in prompts](#built-in-prompts). This means the picker is never empty even before you have saved anything. It uses an in-app, theme-matched list instead of the platform select overlay, keeping the prompt content visible and avoiding oversized native menus on mobile. On first open the picker defaults to the first saved prompt so the editor is already populated; tapping **New** starts a blank form instead. Pick a prompt to load its title, content, and preset into the editor.

- **Scope** — when creating a new prompt while a project is active, choose between **This project** and **App default**.
- **Title** (optional) and **Prompt content** (required — **Create** / **Save** stay disabled while it is empty) are edited in place. An amber hint under the picker says when the form has changes that are not saved yet. The **Chat preset** tool tree is always shown below the content.
- **Icon** — choose Sparkles, Code, Search, Writing, Debug, or Research. Enable **Add to project card** to show the icon beside **+ New chat**. Tapping it creates and opens a chat with this prompt already selected. Chats created this way also show the prompt icon in their project-card row.
- **Insert a default…** — under the Prompt content field of a custom prompt, tap **Insert a default…** to reveal the three built-in prompt-size profiles that have text (`Very small`, `Average`, `Extensive`). Tap one to load its `systemMessage` into the content editor as a starting point, then edit and Save as your own custom prompt.
- Tap **Save** (or **Create** for a new prompt) to persist. The action bar is pinned to the bottom of the screen, so it stays reachable on a phone without scrolling past the preset tree. Tap **Delete** to remove the selected prompt — the API cascade-clears `promptId` on every chat that referenced it, while those chats keep the pinned copy of the prompt's text (see [Prompt snapshots](#prompt-snapshots)).

### Built-in prompts

The built-in prompt-size profiles appear in the same picker and open in the same editor as a custom prompt, with these differences:

- **Title** and **Prompt content** are read-only — the text is defined in `src/promptProfiles.js`. `Chat` shows an empty content field because it sends no system prompt.
- **Icon** and **Add to project card** work exactly as for a custom prompt. When pinned, the icon appears on the project card beside **+ New chat**; tapping it creates a chat with that prompt style (`POST /api/chats` with `promptSize: "<profile id>"`).
- On a project screen, **Save icon settings to** chooses **This project** (the project's `.mouaif.json`) or **App default** (the app SQLite store). Saving to App default also removes this project's override for that profile, so the app value applies. On the App-defaults screen it always saves to the app store.
- There is no **Chat preset** and no **Delete** — a built-in cannot be removed.

The launcher settings are stored under the `profileLaunchers` settings key, resolved defaults → app → project like any other setting:

```json
{
  "profileLaunchers": {
    "chat": { "icon": "pencil", "showOnProjectCard": true }
  }
}
```

`icon` is one of `sparkles`, `code`, `search`, `pencil`, `bug`, `book` (anything else falls back to `sparkles`). The key is written through the existing `PUT /api/settings/app` and `PUT /api/settings/project` routes and is on the app-settings client allowlist.

### Legacy deep links
Older `settings/prompts/:id` URLs still resolve to the same screen with the picker pre-selected to that prompt, so saved links keep working.

### Defining a chat preset

When creating or editing a prompt, the **Chat preset** tree is always visible under the prompt content — there is no separate on/off switch. It uses the same controls as the rest of the settings:

- the **tool tree** — the same `ToolTree` shown by the chat Tools card and Settings → Project. Native tools (`shell`, `subagent`, the Chats family with its `ask_user` / `task` / `report_progress` / `webpreview` leaves, the mouaif family, and File tools) and MCP server tools (`mcp__<slug>__<tool>`) are both listed; the project's tool catalog drives which rows are shown. On the **app-defaults** screen there is no project to scope MCP tools to, so `GET /api/tools/list` is called without `projectDir` and returns the native catalog only — `projectDir` is optional on that route.
- a synthetic **Agent files** group at the bottom of the tree. Check it to turn on `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` (the project's `agentFileNames` setting) in new chats made from this prompt.
- a synthetic **Skills** group. Check it to turn on `.agents/skills/*/SKILL.md` (the project's skill catalog) in new chats made from this prompt.

The tree shows what a new chat made from the prompt will get:

- **Tools.** Every row starts checked, because a prompt with no tool selection gives new chats every tool, the same as a chat with no tool list. Unchecking a row saves an explicit list, and new chats start with only the checked tools. Re-checking every row goes back to "every tool", so the prompt never pins a stale full list that would hide tools added later. Unchecking every row saves an empty list: new chats start with no tools.
- **Agent files and Skills.** A checked group turns the feature on for new chats. An unchecked group is not saved, so new chats keep their default (the prompt-size profile decides). An explicit `false` can still be written by hand in the prompt record.

The project's Off/Ask/Allow gate for each tool stays authoritative — a tool the project turned `off` remains off even if a preset lists it. The project's master switches (`agentFiles: false`, `skills: false`) lock the matching preset group off, just like the chat's ToolPopup does. Leaving every tool checked with Agent files and Skills unchecked saves no preset at all (`preset` is cleared from the prompt record). The prompt list shows a short `preset` badge so the attachment is visible at a glance.

### Using a prompt in a chat

A chat uses a custom prompt through its `promptId`. There are three ways to set it:

- **Project card.** Turn on **Add to project card** for the prompt, then tap its icon beside **+ New chat**. That creates a chat with the prompt attached (`POST /api/chats` with `promptId`).
- **REST.** `POST /api/chats` with `{ projectDir, promptId }` creates a chat from the prompt; `PATCH /api/chats/:id` with `{ projectDir, promptId }` attaches it to an existing chat (`""` or `null` detaches it).
- **The `update_chat` tool.** A model can attach a prompt to a chat with `promptId` (`""` clears it).

Agents carry no prompt; they are subagent delegation targets only.

Attaching a prompt pins a snapshot of its current text onto the chat (see [Prompt snapshots](#prompt-snapshots)). A preset is applied when the chat is created from the prompt, or when the prompt is attached to a chat that has no messages yet (see [Chat integration](#chat-integration-presets)).

The prompt is not visible in the transcript — it is prepended server-side when building the upstream message array.

### Schema

Each prompt is stored as an object:

```json
{
  "id": "a1b2c3d4",
  "title": "Code reviewer",
  "icon": "code",
  "showOnProjectCard": true,
  "content": "You are an expert code reviewer. Be thorough and constructive.",
  "role": "system",
  "preset": {
    "tools": ["shell", "read_file", "search_files", "mcp__chrome_debug__navigate"],
    "agentFiles": true
  },
  "createdAt": "2026-07-15T12:00:00.000Z",
  "updatedAt": "2026-07-15T12:00:00.000Z"
}
```

The `icon` field is restricted to built-in keys (`sparkles`, `code`, `search`, `pencil`, `bug`, or `book`); unknown values safely fall back to `sparkles`. `showOnProjectCard` defaults to `false` for existing prompts.

The `role` field is preserved on disk for forward-compat and hand-edits, but the editor and the validator only accept `system`. A non-system role in the file is silently coerced to `system` on read.

`preset` is optional. It is normalized to `{ tools?, agentFiles?, skills? }`:

- `tools` is a de-duped array of the model-facing tool names the tool tree shows: native tools (`shell`, `subagent`, `task`, `ask_user`, `read_file`, `edit_file`, `group_read`, `group_cli`, …), MCP tool ids (`mcp__<slug>__<tool>`), and `mcp__<slug>__*` for every tool of one MCP server. Family names such as `chats` or `mouaif` are not tool names and are dropped, as are other unknown entries. The legacy family name `file` expands to every file operation. Absent means every tool; an empty list means no tools.
- `agentFiles` is a boolean copied onto new chats' agent-file toggle.
- `skills` is a boolean copied onto new chats' skills toggle.

### Chat schema

A chat references a prompt through `promptId` and carries the pinned copy in `promptSnapshot`:

```json
{
  "id": "9f2c1ab3",
  "title": "Refactor the parser",
  "promptId": "a1b2c3d4",
  "promptSnapshot": {
    "title": "Code reviewer",
    "content": "You are an expert code reviewer. Be thorough and constructive.",
    "role": "system",
    "preset": {
      "tools": ["shell", "read_file", "search_files"],
      "agentFiles": true
    }
  },
  "tools": ["shell", "read_file", "search_files"],
  "agentFiles": true
}
```

- `promptId` is provenance and the fallback path. It becomes `null` when the prompt is deleted.
- `promptSnapshot` is the copy the turn actually sends. It is stored as JSON in the `prompt_snapshot` column of `chat_store`, and a chat written before snapshots existed has `NULL` there — those chats resolve live by `promptId`.
- `promptSnapshot.preset` is optional and only present when the prompt had a preset at attach time. It is a record of where the chat's settings came from; the stream reads the chat's own `tools`, `agentFiles` and `skills`, which the preset seeded.

A preset with no `tools` field and no `agentFiles` or `skills` collapses to `null` (no preset). A `tools` list whose every entry was dropped as unknown counts as no `tools` field. An explicit empty `tools` list, `agentFiles: false` and `skills: false` are kept.

### Prompt snapshots

Attaching a prompt to a chat pins a **snapshot** of it onto that chat: the prompt's `title`, `content`, `role`, and `preset` as they were at attach time. Every later turn sends the snapshot, not the live prompt.

This is what makes a shared prompt safe to edit. A prompt is a library entry that many chats can reference; if the server re-read `promptId` on every turn, fixing a typo in a prompt would silently rewrite the system message of every chat that had ever used it — including chats whose transcripts were already built around the old wording, and whose cached prompt prefix would then be invalidated. With a snapshot:

- Editing a prompt affects **new** chats only. Chats already attached keep the text they were attached with.
- Re-attaching a chat to a prompt (PATCHing `promptId`) re-pins it to the prompt's current text. If the chat has no messages yet, the prompt's preset also seeds its settings, as at creation.
- Detaching (`promptId: null`) clears the pin, leaving the chat with no custom prompt.
- **Deleting** a prompt drops the reference (`promptId` becomes `null`) but keeps the pinned text, so a chat that used the prompt goes on behaving exactly as it did.

Two fallbacks keep this client-safe:

- A chat with no snapshot — any chat written before snapshots existed — resolves live by `promptId`, which is the old behaviour exactly.
- A snapshot that is unreadable, or that names a prompt with no usable text, is ignored and the live lookup is used instead. A malformed snapshot degrades to the old behaviour rather than to no prompt.

`promptSnapshot` is server-owned: it is derived from `promptId` on create and PATCH, and a client-supplied `promptSnapshot` is stripped from `POST /api/chats` and `PATCH /api/chats/:id`. The one internal writer is the delete cascade in `chats.clearPromptId`.

### Chat integration (presets)

When the server processes `POST /api/chats/:id/messages/stream`, the chat's custom prompt is resolved through `prompts.resolveChatPrompt(projectDir, chat)`, which prefers the pinned `promptSnapshot` and falls back to a live lookup by `promptId`. The resolved content is appended to the upstream message array as a `{ role: 'system', content }` entry before `ai.streamChat` is called. The prompt is not stored in the chat transcript — it is ephemeral and only sent to the model.

A preset is not applied per turn. It is a seed, copied onto the chat record by `chats.createChat` (through `prompts.presetSeed`):

- **Tools.** `preset.tools` becomes the chat's tool list (`chat.tools`). With no `preset.tools`, the chat has no list and gets every tool.
- **Agent files and skills.** `preset.agentFiles` and `preset.skills` become the chat's own toggles. A field the preset leaves out leaves the chat's default alone.
- **Explicit settings win.** `tools`, `agentFiles` or `skills` passed in the same `POST /api/chats` (or the same PATCH) take precedence over the preset.
- **Attaching later.** PATCHing `promptId` onto a chat with no messages seeds it the same way. A chat that already has messages keeps its own settings, and detaching a prompt changes nothing.

Because the chat stores the result, the Tools card shows exactly what the model gets, and the user can change any of it afterwards. The project's authorization gate (`off` / `ask` / `allow` per tool, the project-level `agentFiles: false` lock, and the project-level `skills: false` lock) still applies on every turn — a project lock overrides a seeded value.
