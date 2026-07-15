# Custom prompts

User-authored system/role prompts, stored per project. Each chat can reference one custom prompt which is automatically injected as a message of the configured role before the conversation transcript.

## Overview

Custom prompts let you define reusable system, user, or assistant messages that are prepended to every chat turn. They are stored in the project's `.mouaif.json` file alongside other settings, so they can be committed to version control and shared with collaborators.

This feature implements the "Custom prompts" requirement from the project instructions (`.github/copilot-instructions.md` §4).

## Usage

### Managing prompts (Settings UI)

1. Navigate to **Settings → Custom prompts**.
2. Enter a **project directory** (the folder containing the project's `.mouaif.json`).
3. Tap **Load** to see existing prompts.
4. Tap **+ Add prompt** to create a new one.
5. Fill in:
   - **Title** — A short label.
   - **Role** — `system`, `user`, or `assistant`. The prompt will be inserted as a message with this role.
   - **Prompt content** — The text to inject.
6. Tap **Create** to save.

Existing prompts can be edited or deleted from the same screen.

### Using a prompt in a chat

1. Open a chat.
2. Tap the **gear icon** (chat settings popover).
3. In the **Prompt** dropdown, select the desired custom prompt (or `(none)` to disable).
4. The selected prompt is saved to the chat record and will be injected on every stream turn.

The prompt is not visible in the transcript — it is prepended server-side when building the upstream message array.

### API

Prompts are managed via REST endpoints on the mouaif server:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/prompts?projectDir=<abs>` | List all prompts for a project |
| `GET` | `/api/prompts/:id?projectDir=<abs>` | Get a single prompt |
| `POST` | `/api/prompts` | Create a prompt (body: `{ projectDir, title?, content, role? }`) |
| `PATCH` | `/api/prompts/:id` | Update a prompt (body: `{ projectDir, title?, content?, role? }`) |
| `DELETE` | `/api/prompts/:id?projectDir=<abs>` | Delete a prompt |

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

### Chat integration

When the server processes `POST /api/chats/:id/messages/stream`, if the chat record has a `promptId` field referencing an existing prompt, the server prepends `{ role: prompt.role, content: prompt.content }` to the upstream message array before calling `ai.streamChat`. The prompt is not stored in the chat transcript — it is ephemeral and only sent to the model.

## Implementation notes

- Backend: `src/prompts.js` — CRUD module. No new runtime dependencies.
- Routes: `src/index.js` — `handlePrompts()` function, mounted at `/api/prompts/*`.
- Chat integration: `src/chats.js` — `promptId` field added to the chat schema and `updateChat` allowlist.
- Stream injection: `src/index.js` `handleChatStream()` — prepends the prompt message before the history.
- Frontend: `src/web/src/components/SettingsPrompts.jsx` — list and edit views.
- Chat UI: `src/web/src/components/Chat.jsx` — prompt selector in the settings popover.
- Prompts are **not** versioned or shared between projects. Each project owns its own list.
- Deleting a prompt does **not** clear `promptId` on existing chats — they will silently skip the missing prompt at stream time.