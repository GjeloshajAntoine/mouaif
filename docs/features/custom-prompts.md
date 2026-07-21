# Custom prompts

User-authored **system** prompts, stored per project. Each chat can reference one custom prompt, which is automatically injected as the first message of every stream turn.

## Overview

Custom prompts let you define reusable system messages that are prepended to every chat turn. They are stored in the project's `.mouaif.json` file alongside other settings, so they can be committed to version control and shared with collaborators.

The role is fixed to `system`: a custom prompt is always the opening system message of the turn, never an injected `user` or `assistant` message. Prepending a fake user/assistant message before the transcript would bias the conversation; if you need that, write it into the actual transcript.

## Usage

### Managing prompts (Settings UI)

1. Open a chat in the project you want to configure (or visit **Settings → Project overrides** and load a project directory).
2. From **Settings → Project overrides → Custom prompts**, the project is already in scope — no path to type.
3. Tap **+ Add prompt** to create a new one. Fill in:
   - **Title** — A short label.
   - **Prompt content** — The text to inject as the system message.
4. Tap **Create** to save.

Existing prompts can be opened, edited, or deleted from the same screen. Deleting a prompt **cascade-clears `promptId`** on every chat in the project that referenced it, so subsequent turns no longer try to inject the missing prompt.

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
  "createdAt": "2026-07-15T12:00:00.000Z",
  "updatedAt": "2026-07-15T12:00:00.000Z"
}
```

The `role` field is preserved on disk for forward-compat and hand-edits, but the editor and the validator only accept `system`. A non-system role in the file is silently coerced to `system` on read.

### Chat integration

When the server processes `POST /api/chats/:id/messages/stream`, if the chat record has a `promptId` referencing an existing prompt, the server prepends `{ role: 'system', content: prompt.content }` to the upstream message array before calling `ai.streamChat`. The prompt is not stored in the chat transcript — it is ephemeral and only sent to the model.

## Implementation notes

- Backend: [src/prompts.js](../../src/prompts.js) — CRUD module. No new runtime dependencies.
- Routes: [src/index.js](../../src/index.js) — `handlePrompts()` function, mounted at `/api/prompts/*`. The DELETE handler calls [src/chats.js](../../src/chats.js) `clearPromptId()` to cascade-clear references in chats.
- Chat schema: [src/chats.js](../../src/chats.js) — `promptId` field on the chat, allowed in `updateChat`. `normalizeChat` coerces empty / non-string values to `null`.
- Stream injection: [src/index.js](../../src/index.js) `handleChatStream()` — prepends the prompt message before the transcript.
- Frontend: [src/web/src/components/SettingsPrompts.jsx](../../src/web/src/components/SettingsPrompts.jsx) — list and edit views, project-scoped via the `activeProject` signal.
- Chat UI: the chat's prompt is a per-chat selection, independent of agents (which are subagent delegation targets — see [agents.md](./agents.md)).
- Prompts are per-project. Each project owns its own list. There is no app-level prompt library.
- Deleting a prompt cascade-clears `promptId` on every chat in the project; the response includes a `clearedChats` count.
