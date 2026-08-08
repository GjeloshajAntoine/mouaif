# Custom prompts

User-authored **system** prompts, stored per project. Each chat can reference one custom prompt, which is automatically injected as the first message of every stream turn. A prompt can also carry a **chat preset** — a tool allowlist and an agent-files toggle that ride along whenever a chat uses that prompt.

## Overview

Custom prompts let you define reusable system messages that are prepended to every chat turn. They are stored in the project's `.mouaif.json` file alongside other settings, so they can be committed to version control and shared with collaborators.

The role is fixed to `system`: a custom prompt is always the opening system message of the turn, never an injected `user` or `assistant` message. Prepending a fake user/assistant message before the transcript would bias the conversation; if you need that, write it into the actual transcript.

A prompt can additionally define a **preset** (`preset.tools` + `preset.agentFiles`). Presets are chat-default packaging: when a chat references the prompt, those tool and agent-file settings apply to that chat. They are purely additive and never override the project's authorization gate (see [Presets](#presets) below).

## Usage

### Managing prompts (Settings UI)

1. Open a chat in the project you want to configure (or visit **Settings → Project overrides** and load a project directory).
2. From **Settings → Project overrides → Custom prompts**, the project is already in scope — no path to type.
3. Tap **+ Add prompt** to create a new one. Fill in:
   - **Title** — A short label.
   - **Prompt content** — The text to inject as the system message.
4. Tap **Create** to save.

Existing prompts can be opened, edited, or deleted from the same screen. Deleting a prompt **cascade-clears `promptId`** on every chat in the project that referenced it, so subsequent turns no longer try to inject the missing prompt. The prompt list has a **Copy** button on each row that copies the prompt text to the clipboard without opening the editor.

### Defining a chat preset

When creating or editing a prompt, toggle **Chat preset** on to attach a preset. You can then:

- check one or more **tools to enable** — `shell`, file tools, `subagent`, progress updates, `task`, or `ask` user; and
- toggle **Also enable agent files** to inject `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md`.

Presets are **additive**: a chat that already inherits all project tools keeps them (the preset never restricts a chat to just its listed tools), and the project's Off/Ask/Allow gate for each tool stays authoritative — a tool the project turned `off` remains off even if a preset lists it. Turning the preset off clears `preset` from the prompt record. The prompt list shows a short `preset: …` badge so the attachment is visible at a glance.

### Using a prompt in a chat

1. Open **Settings → Agents**.
2. Choose a custom prompt on an agent and save its configuration.
3. Select that agent as the project default or from the chat **Agent** card.
4. The prompt is resolved from the selected agent and injected on every stream turn.

The REST API can still set `chat.promptId` directly for a chat-specific override. Its precedence is higher than the selected agent's prompt.

The prompt is not visible in the transcript — it is prepended server-side when building the upstream message array.

### API

Prompts are managed via REST endpoints on the mouaif server. The `projectDir` parameter is required on every call.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/prompts?projectDir=<abs>` | List all prompts for a project |
| `GET` | `/api/prompts/:id?projectDir=<abs>` | Get a single prompt |
| `POST` | `/api/prompts` | Create a prompt. Body: `{ projectDir, title?, content }` |
| `PATCH` | `/api/prompts/:id` | Update a prompt. Body: `{ projectDir, title?, content? }` |
| `DELETE` | `/api/prompts/:id?projectDir=<abs>` | Delete a prompt. Returns `{ ok, removed, clearedChats }` |

### Schema

Each prompt is stored as an object in the `prompts` array of the project's `.mouaif.json`:

```json
{
  "id": "a1b2c3d4",
  "title": "Code reviewer",
  "content": "You are an expert code reviewer. Be thorough and constructive.",
  "role": "system",
  "preset": {
    "tools": ["shell", "file"],
    "agentFiles": true
  },
  "createdAt": "2026-07-15T12:00:00.000Z",
  "updatedAt": "2026-07-15T12:00:00.000Z"
}
```

The `role` field is preserved on disk for forward-compat and hand-edits, but the editor and the validator only accept `system`. A non-system role in the file is silently coerced to `system` on read.

`preset` is optional. It is normalized to `{ tools?, agentFiles? }` where `tools` is a de-duped array of tool *family* names (`shell`, `file`, `subagent`, `report_progress`, `task`, `ask_user`) and `agentFiles` is a boolean. A preset with neither an empty tool list nor a boolean `agentFiles` collapses to `null` (no preset).

### Chat integration (presets)

When the server processes `POST /api/chats/:id/messages/stream`, if the chat record has a `promptId` referencing an existing prompt, the server prepends `{ role: 'system', content: prompt.content }` to the upstream message array before calling `ai.streamChat`. The prompt is not stored in the chat transcript — it is ephemeral and only sent to the model.

If the referenced prompt carries a `preset`, the chat's **effective** per-chat config for that turn also picks it up (via `prompts.effectivePresetConfig`):

- **Tools** (from `preset.tools`) are unioned onto the chat's own per-chat tool allowlist (`chat.tools`). A chat with **no** allowlist already inherits every project tool, so the preset deliberately does *not* replace it with just the preset's list — that would downgrade capability to "enable".
- **Agent files** (`preset.agentFiles`) become the per-chat toggle value passed to `agentFiles.resolveEnabled`, so a preset can turn injection on for a chat.

The preset is merged onto the chat record **in memory only** for that request (`effectiveChat`); the persisted chat record is never modified. The project's authorization gate (`off` / `ask` / `allow` per tool, and the project-level agent-files lock) is read *after* the merge and stays authoritative.

## Implementation notes

- Backend: [src/prompts.js](../../src/prompts.js) — CRUD module plus `normalizePreset`, `getPromptPreset`, and `effectivePresetConfig`. No new runtime dependencies.
- Routes: `handlePrompts()`, mounted at `/api/prompts/*` from [src/server-handlers-prompts.js](../../src/server-handlers-prompts.js) (dispatched in [src/http-server.js](../../src/http-server.js)). The DELETE handler calls [src/chats.js](../../src/chats.js) `clearPromptId()` to cascade-clear references in chats.
- Chat schema: [src/chats.js](../../src/chats.js) — `promptId` field on the chat, allowed in `updateChat`. `normalizeChat` coerces empty / non-string values to `null`. Prompts are per-project; `preset` lives on the prompt record, not the chat.
- Stream injection + preset linkage: `handleChatStream()` in [src/server-handlers-chats.js](../../src/server-handlers-chats.js) builds `effectiveChat` from the prompt preset and feeds it to the agent-files resolver and the per-chat `enabledTools` filter. The `/system-prompt` endpoint mirrors the same logic so the transcript's first message reflects the preset.
- Frontend: [frontend/src/components/SettingsPrompts.jsx](../../frontend/src/components/SettingsPrompts.jsx) — list and edit views, project-scoped via the `activeProject` signal. The list has a per-row **Copy** button and a `preset:` badge; the edit view has a Chat preset section (tool checklist + agent-files toggle). Styles in [frontend/src/settings.css](../../frontend/src/settings.css).
- Chat UI: the chat's prompt is a per-chat selection, independent of agents (which are subagent delegation targets — see [agents.md](./agents.md)).
- Prompts are per-project. Each project owns its own list. There is no app-level prompt library.
- Deleting a prompt cascade-clears `promptId` on every chat in the project; the response includes a `clearedChats` count.
