# Prompt-size profiles

## Overview

`mouaif` ships three hand-written system prompts — `very-small`, `average`, and `extensive` — that the chat stream prepends to the upstream `messages` array, in front of any custom prompt and the transcript. Every chat carries a `promptSize` field, so each chat can pick its own profile. The same field is also stored on the project (`<projectDir>/.mouaif.json`) and the app store, so projects and the app itself can pin a default. The active profile is resolved at request time, per the same `defaults → app → project → chat` order as the rest of the settings stack.

This feature implements the "Three prompt-size profiles" entry in `.github/copilot-instructions.md` §4. The profile text is intentionally a single static block per size; the goal is **predictability** and **a small prompt budget**, not a per-provider conversation about identity.

## Usage

### Picking a profile

- **In the chat** — open the chat, tap the ⚙ button, pick a value from the **Prompt size** dropdown. The change is `PATCH /api/chats/:id { promptSize: '…' }` and is applied to the next message.
- **For the whole project** — set `promptSize` under the project in `<projectDir>/.mouaif.json` (e.g. `{ "promptSize": "extensive" }`). New chats inherit it. Existing chats are unaffected unless they have their own override.
- **App-wide default** — `PUT /api/settings/app { "promptSize": "very-small" }`, or change the **Default prompt size** dropdown in **Settings → Defaults**. Used when the project has no value.

### Reading the active profile

The chat meta line under the chat title shows the active profile (e.g. `Average · trace off`). The same info is rendered in **Settings → Chat defaults** and in the chat popover as a one-line description under the picker.

### The three profiles

| ID | Label | When to use it |
|---|---|---|
| `very-small` | Very small | Tight context budgets, low-latency replies, or when the model is already well-aligned and you want a tiny floor prompt. |
| `average` | Average | The recommended default. Identity + concise guidance on how to answer. |
| `extensive` | Extensive | When you want the model to be deliberate, follow the trace / tool guidelines, and use worked examples. |

The default is `average`. The chat, the project, and the app can each override it; the most specific one wins.

## Behavior

- **Where the profile lives in the message list**: `handleChatStream` builds the upstream `messages` array in this order — (1) the active profile's system message, (2) the chat's custom prompt (if any), (3) the transcript (user + assistant turns). The profile is **always** present, even when the chat has no custom prompt and no prior messages.
- **Resolution order**: `chat.promptSize → resolved project.promptSize → app.promptSize → 'average'`. An invalid or missing value falls through to the next layer; nothing throws. The function is safe to call on a half-loaded chat record.
- **Static text**: the three prompts are baked into the build (see [Implementation notes](#implementation-notes)). They are not per-provider, they do not include the discovered MCP tool list, and they do not change at request time. A future commit can swap to per-provider or per-tool prompts without changing the public surface.
- **Custom prompts are layered on top, not instead of**. A chat with `promptId: 'review-mode'` sends `[profile, custom-prompt, …transcript]`. The custom prompt's own instructions say "where they do not conflict with the active profile", so the layering is intentional, not accidental.
- **Read endpoint**: `GET /api/prompt-profiles` returns `{ default, profiles: [{ id, label, description, summary, systemMessage }, …] }`. Used by the chat popover and (in a follow-up) the Settings UI to render a picker without hard-coding labels. The system messages are returned so a future "preview the active prompt" pane can show what the model is being told.

## HTTP surface

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/api/prompt-profiles` | — | `{ default, profiles: [...] }` |

The chat's profile is set with the existing `PATCH /api/chats/:id { promptSize }` and is read back on `GET /api/chats/:id`. The project's profile is set with `PUT /api/settings/project { projectDir, promptSize }`. The app's default is set with `PUT /api/settings/app { promptSize }`.

## Implementation notes

- New module: [src/promptProfiles.js](../../src/promptProfiles.js). Public surface: `PROFILES`, `DEFAULT_PROFILE`, `isValidProfile`, `profileSystemMessage`, `describeProfile`, `listProfiles`, `resolveProfile`. The module exports a frozen `PROFILES` object and a `resolveProfile({ chat, projectDir })` helper that performs the layered lookup and never throws.
- New HTTP route in [src/index.js](../../src/index.js): `GET /api/prompt-profiles`. Handled in the main router, before `/api/chats`.
- `handleChatStream` in [src/index.js](../../src/index.js) now prepends `promptProfiles.resolveProfile({ chat, projectDir }).systemMessage` as a `role: 'system'` message at index 0 of `upstreamMessages`, before the existing custom-prompt block. The block is wrapped in a `try/catch` so a profile-resolution failure cannot kill the stream.
- Mobile UI changes (in [src/web/src/components/Chat.jsx](../../src/web/src/components/Chat.jsx)):
  - The chat popover's **Prompt size** dropdown is now populated from `GET /api/prompt-profiles` instead of being hard-coded. Hard-coding the three options would have drifted the first time a profile was renamed.
  - A one-line description under the picker (`.chat-view__settings-hint` in [style.css](../../src/web/src/style.css)) shows the active profile's `description` and updates on every change.
  - The chat meta line under the title shows the friendly `label` ("Average") instead of the raw id ("average"), so the meta line is human-readable.
- `package.json → scripts.prepublishOnly` now also runs `node -c src/promptProfiles.js` so a syntax error in the new module blocks the publish.
- New smoke test: [scripts/test-prompt-profiles.js](../../scripts/test-prompt-profiles.js). 50 assertions covering the module's public surface, the resolution order, and the `GET /api/prompt-profiles` endpoint. Run with `node scripts/test-prompt-profiles.js`.

## Related

- Decisions: [docs/decisions.md §9](../decisions.md) (build order — "prompt-size profiles").
- Settings resolution: [App and project settings](./app-and-project-settings.md).
- Custom prompts: [Custom prompts](./custom-prompts.md) — the system-prompt layer that sits between the profile and the transcript.
- Chat UI: [Chat UI](./chat-ui.md) — where the picker lives.
