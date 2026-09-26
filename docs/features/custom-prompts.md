# Custom prompts

## Overview

Custom prompts let you define reusable system messages that are prepended to every chat turn. Prompts can be configured at two scopes:

- **App defaults** — stored in the app SQLite database (`~/.mouaif/store.sqlite`) under `prompts`, available across all projects.
- **Project-specific** — stored in `<projectDir>/.mouaif.json` alongside other project settings, committed to version control. Project prompts take precedence over app prompts with the same ID.

The role is fixed to `system`: a custom prompt is always the opening system message of the turn, never an injected `user` or `assistant` message. Prepending a fake user/assistant message before the transcript would bias the conversation; if you need that, write it into the actual transcript.

A prompt can additionally define a **preset** (`preset.tools` + `preset.agentFiles` + `preset.skills`). Presets are chat-default packaging: when a chat references the prompt, those tool, agent-file, and skill settings apply to that chat. They are purely additive and never override the project's authorization gate (see [Presets](#presets) below).

Each prompt also has a safe built-in icon (a set of hand-drawn, stroke-based SVG glyphs). The optional **Add to project card** setting exposes that icon as a one-tap new-chat action on every project card where the prompt is available.

## Usage

### Managing prompts (Settings UI)

Prompts can be managed from two locations in Settings:
1. **Settings → App defaults → Custom prompts** (`#/settings/prompts`): Manage global custom prompts that apply across all projects.
2. **Settings → This project → Custom prompts** (`#/settings/prompts?projectDir=...`): Manage project-specific prompts and view inherited app-wide prompts.

The **Prompt** picker lists every saved prompt (with a `preset` tag for ones that carry a tool/agent-file/skills preset; scope badges only appear on the project screen, where the two scopes are mixed, and are omitted on the single-scope App-defaults screen) plus a `+ New prompt` entry for a blank form. Below the saved prompts, a **Start from a default** section lists the three built-in prompt-size profiles (`Very small`, `Average`, `Extensive`, each tagged `default`); tapping one opens a fresh unsaved prompt pre-filled with that profile's title and `systemMessage`, ready to edit and Create. This means the picker is never empty even before you have saved anything. It uses an in-app, theme-matched list instead of the platform select overlay, keeping the prompt content visible and avoiding oversized native menus on mobile. On first open the picker defaults to the first saved prompt so the editor is already populated; tapping **New** starts a blank form instead. Pick a prompt to load its title, content, and preset into the editor.

- **Scope** — when creating a new prompt while a project is active, choose between **This project** and **App default**.
- **Title** (optional until saved) and **Prompt content** are edited in place. Toggle **Chat preset** to attach or detach the tool/agent-file/skills bundle.
- **Icon** — choose Sparkles, Code, Search, Writing, Debug, or Research. Enable **Add to project card** to show the icon beside **+ New chat**. Tapping it creates and opens a chat with this prompt already selected. Chats created this way also show the prompt icon in their project-card row.
- **Copy from default** — under the Prompt content field, tap **Copy from default** to reveal the three built-in prompt-size profiles (`Very small`, `Average`, `Extensive`). Tap one to load its `systemMessage` into the content editor as a starting point, then edit and Save as your own custom prompt.
- Tap **Save** (or **Create** for a new prompt) to persist. Tap **Delete** to remove the selected prompt — the API cascade-clears `promptId` on every chat that referenced it.

### Legacy deep links
Older `settings/prompts/:id` URLs still resolve to the same screen with the picker pre-selected to that prompt, so saved links keep working.

### Defining a chat preset

When creating or editing a prompt, toggle **Chat preset** on to attach a preset. The preset uses the same controls as the rest of the settings:

- the **tool tree** — the same `ToolTree` shown by the chat Tools card and Settings → Project. Native tools (`shell`, `file`, `subagent`, `report_progress`, `task`, `ask_user`) and MCP server tools (`mcp__<slug>__<tool>`) are both listed; the project's tool catalog drives which rows are shown. On the **app-defaults** screen there is no project to scope MCP tools to, so `GET /api/tools/list` is called without `projectDir` and returns the native catalog only — `projectDir` is optional on that route.
- a synthetic **Agent files** group at the bottom of the tree. Toggle it to inject `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` (the project's `agentFileNames` setting) into every chat that uses this prompt.
- a synthetic **Skills** group. Toggle it to inject `.agents/skills/*/SKILL.md` (the project's skill catalog) into every chat that uses this prompt.

Presets are **additive**: a chat that already inherits all project tools keeps them (the preset never restricts a chat to just its listed tools), and the project's Off/Ask/Allow gate for each tool stays authoritative — a tool the project turned `off` remains off even if a preset lists it. The project's master switches (`agentFiles: false`, `skills: false`) lock the matching preset group off, just like the chat's ToolPopup does; the preset cannot override a project lock. Turning the preset off clears `preset` from the prompt record. The prompt list shows a short `preset: …` badge so the attachment is visible at a glance.

### Using a prompt in a chat

1. Open **Settings → Agents**.
2. Choose a custom prompt on an agent and save its configuration.
3. Select that agent as the project default or from the chat **Agent** card.
4. The prompt is resolved from the selected agent and injected on every stream turn.

The REST API can still set `chat.promptId` directly for a chat-specific override. Its precedence is higher than the selected agent's prompt.

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
    "tools": ["shell", "file", "mcp__chrome_debug__navigate"],
    "agentFiles": true,
    "skills": true
  },
  "createdAt": "2026-07-15T12:00:00.000Z",
  "updatedAt": "2026-07-15T12:00:00.000Z"
}
```

The `icon` field is restricted to built-in keys (`sparkles`, `code`, `search`, `pencil`, `bug`, or `book`); unknown values safely fall back to `sparkles`. `showOnProjectCard` defaults to `false` for existing prompts.

The `role` field is preserved on disk for forward-compat and hand-edits, but the editor and the validator only accept `system`. A non-system role in the file is silently coerced to `system` on read.

`preset` is optional. It is normalized to `{ tools?, agentFiles?, skills? }`:

- `tools` is a de-duped array of model-facing tool names — the native family names (`shell`, `file`, `subagent`, `report_progress`, `task`, `ask_user`) and MCP tool ids (`mcp__<slug>__<tool>`). Unknown entries are dropped.
- `agentFiles` is a boolean: when `true`, the chat referencing this prompt turns agent-file injection on.
- `skills` is a boolean: when `true`, the chat referencing this prompt turns skill injection on.

A preset whose `tools` is empty (or missing) AND whose `agentFiles` and `skills` are both absent collapses to `null` (no preset). An explicit `agentFiles: false` or `skills: false` is preserved (it sets the per-chat toggle to its off state for chats using this prompt) and is not collapsed.

### Chat integration (presets)

When the server processes `POST /api/chats/:id/messages/stream`, if the chat record has a `promptId` referencing an existing prompt, the server prepends `{ role: 'system', content: prompt.content }` to the upstream message array before calling `ai.streamChat`. The prompt is not stored in the chat transcript — it is ephemeral and only sent to the model.

If the referenced prompt carries a `preset`, the chat's **effective** per-chat config for that turn also picks it up (via `prompts.effectivePresetConfig`):

- **Tools** (from `preset.tools`) are unioned onto the chat's own per-chat tool allowlist (`chat.tools`). A chat with **no** allowlist already inherits every project tool, so the preset deliberately does *not* replace it with just the preset's list — that would downgrade capability to "enable".
- **Agent files** (`preset.agentFiles`) become the per-chat toggle value passed to `agentFiles.resolveEnabled`, so a preset can turn injection on for a chat.
- **Skills** (`preset.skills`) become the per-chat value passed to `agentSkills.resolve` and the `list_features` summary, so a preset can turn skill injection on (or back on for a chat that has it explicitly off) for a chat.

The preset is merged onto the chat record **in memory only** for that request (`effectiveChat`); the persisted chat record is never modified. The project's authorization gate (`off` / `ask` / `allow` per tool, the project-level `agentFiles: false` lock, and the project-level `skills: false` lock) is read *after* the merge and stays authoritative — a project lock overrides a preset's value.
