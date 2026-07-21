# Agent Presets

## Overview

Agent presets are named, reusable bundles that combine a custom prompt, a tool filter, and per-skill selection into a single profile. Instead of configuring these three dimensions separately for every chat, a user can create a preset once and apply it to any chat in the project. The preset's values are merged with the chat's own settings — chat-level values always win, so the user can apply a preset and then tweak individual dimensions without losing the preset association.

## Usage

### Create a preset

In the mobile UI, go to **Settings → Active project → Agent presets** and tap **+ New**. Give it a title and optionally pick:

- A **custom prompt** from the project's prompt list.
- A **tool filter** — comma-separated tool names (e.g. `shell, read_file, write_file`). Empty means all tools.
- **Skills** — individual `.agents/skills/*/SKILL.md` files to include. Checked = include, unchecked = exclude. If none are checked, all discovered skills are injected.

### Apply a preset to a chat

When a chat is open, a **Preset** card appears in the transcript area (below the tools card). Tap the dropdown to select a preset. The preset's prompt, tool filter, and skill selection take effect on the next turn.

Chat-level settings override the preset:

- If the chat has its own `promptId`, it wins over the preset's prompt.
- If the chat has its own `tools` array, it wins over the preset's tool filter.
- If the chat has its own `selectedSkills`, it wins over the preset's skill selection.

The preset association (`presetId`) is stored on the chat record. Prompt and tool values are resolved from the referenced preset at turn time. Selecting a preset also copies its current skill selection into the chat so the Skills card can immediately display and edit it.

### REST API

| Method | Path | Query | Body | Response |
|--------|------|-------|------|----------|
| `GET` | `/api/presets` | `?projectDir=<abs>` | — | `{ presets: [...] }` |
| `GET` | `/api/presets/:id` | `?projectDir=<abs>` | — | `{ preset }` or 404 |
| `POST` | `/api/presets` | — | `{ projectDir, title, promptId?, enabledTools?, selectedSkills? }` | `{ preset }` (201) |
| `PATCH` | `/api/presets/:id` | — | `{ projectDir, title?, promptId?, enabledTools?, selectedSkills? }` | `{ preset }` |
| `DELETE` | `/api/presets/:id` | `?projectDir=<abs>` | — | `{ ok, removed }` |

Deleting a preset cascade-cleans `presetId` on every chat in the project so no chat carries a dangling reference.

### Chat PATCH fields

The chat record accepts two new fields in `PATCH /api/chats/:id`:

- `presetId` — references a preset by its id. Setting to `null` clears the association.
- `selectedSkills` — an array of skill names to inject. `null` means all discovered skills. `[]` means no skills.

### Skill selection

When a preset (or chat) has `selectedSkills`, only those named skills from `.agents/skills/*/SKILL.md` are injected into the upstream system context. If `selectedSkills` is `null`, all discovered skills are injected (subject to the skills enabled toggle and prompt-size profile). If `selectedSkills` is an empty array, no skills are injected.

The chat UI shows a **Skills** card (below the Preset card) with per-skill checkboxes. The user can toggle individual skills on or off, which updates `selectedSkills` on the chat record. An "All skills" checkbox resets to `null`.

## Implementation notes

- New module: `src/agentPresets.js`. Public surface:
  - `listPresets(projectDir)`, `getPreset(projectDir, id)`, `createPreset(projectDir, opts)`, `updatePreset(projectDir, id, patch)`, `deletePreset(projectDir, id, opts)`
  - `applyPreset({ projectDir, presetId, chat })` — resolves a preset and validates its references. Returns `{ promptId, enabledTools, selectedSkills }` or `null`.
  - `resolvePresetFields({ projectDir, chat })` — merges preset fields with chat overrides. Chat-level values win.
- Chat record fields added: `presetId` (string or null), `selectedSkills` (array or null).
- REST endpoints: `handlePresets` in `src/index.js`.
- Message injection: `handleChatStream` in `src/index.js` resolves preset fields before injecting skills and the custom prompt, and passes resolved `enabledTools` to the AI client.
- The `system-prompt` endpoint returns a `preset` block with `presetId`, `resolvedPromptId`, `resolvedEnabledTools`, and `resolvedSelectedSkills`.
- The `list_features` tool and `GET /api/features` report `agentPresets` state.
- UI: `src/web/src/components/SettingsPresets.jsx` (list + create/delete), preset picker and skills card in `cards.js`, mount/update functions in `cards.js`.

## Related

- [Custom prompts](./custom-prompts.md) — presets reference prompts by id.
- [Agent skills](./agent-skills.md) — presets control which individual skills are injected.
- [Tool authorization](./tool-authorization.md) — the tool filter in a preset restricts which tools the model can call.
- [Agent feature prompt and tool](./agent-feature-prompt.md) — `list_features` reports preset state.
- Source: `src/agentPresets.js`, `src/index.js`, `src/chats.js`, `src/web/src/components/SettingsPresets.jsx`, `src/web/src/components/chat/cards.js`, `src/web/src/components/chat/transcript.js`.