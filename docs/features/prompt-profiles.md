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

The resolved system prompt (the active profile's text, plus any custom prompt) is rendered as a **collapsible "System prompt" card at the top of the transcript** — the first message of every chat. Tap it to expand and read exactly what the model is being sent. The prompt-size no longer clutters the chat meta line (which now shows only the trace state); the profile is a first-class, on-demand message instead of a permanent picker readout. The picker itself still lives in the chat ⚙ popover with a one-line description, and the app default is in **Settings → App defaults**.

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
- **Tool-declaration reduction** (the core of this feature): the profile controls how much of each tool is advertised to the model, not just the system-prompt text.
  - `very-small`: each tool is sent as its **name + a one-line description** (first line, clamped to ~120 chars) with an **empty parameter schema** (`{ type: 'object', properties: {} }`). Smallest possible tool budget.
  - `average` / `extensive`: the **full** tool specs (name + full description + `parameters`).
  This is done by `promptProfiles.reduceToolSpecs(specs, profileId)`, applied in `src/ai.js` after both tool sources (native `shell` + MCP) are collected, so every advertised tool is reduced uniformly. The reduction is driven by the resolved profile id that `handleChatStream` passes to `streamChat` as `opts.promptSize`.
- **Static text**: the three system prompts are baked into the build. They are not per-provider. The tool list is injected separately and reduced per the rule above.
- **Custom prompts are layered on top, not instead of**. A chat with `promptId: 'review-mode'` sends `[profile, custom-prompt, …transcript]`. The custom prompt's own instructions say "where they do not conflict with the active profile", so the layering is intentional, not accidental.
- **Read endpoints**:
  - `GET /api/prompt-profiles` returns `{ default, profiles: [{ id, label, description, summary, systemMessage }, …] }`. Used by the chat popover to render the picker without hard-coding labels.
  - `GET /api/chats/:id/system-prompt?projectDir=…` returns `{ profile, prompt, text }` — the **resolved** system context for that specific chat (the profile it will actually use plus its custom prompt, if any). `text` is the concatenation in upstream order. The chat UI uses this to render the first-message system-prompt card, so the card always reflects what `handleChatStream` will send.

## HTTP surface

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/api/prompt-profiles` | — | `{ default, profiles: [...] }` |
| GET | `/api/chats/:id/system-prompt` | `?projectDir=` | `{ profile, prompt, text }` |

The chat's profile is set with the existing `PATCH /api/chats/:id { promptSize }` and is read back on `GET /api/chats/:id`. The project's profile is set with `PUT /api/settings/project { projectDir, promptSize }`. The app's default is set with `PUT /api/settings/app { promptSize }`.

## Implementation notes

- New module: [src/promptProfiles.js](../../src/promptProfiles.js). Public surface: `PROFILES`, `DEFAULT_PROFILE`, `isValidProfile`, `profileSystemMessage`, `describeProfile`, `listProfiles`, `resolveProfile`. The module exports a frozen `PROFILES` object and a `resolveProfile({ chat, projectDir })` helper that performs the layered lookup and never throws.
- New HTTP route in [src/index.js](../../src/index.js): `GET /api/prompt-profiles`. Handled in the main router, before `/api/chats`.
- `handleChatStream` in [src/index.js](../../src/index.js) now prepends `promptProfiles.resolveProfile({ chat, projectDir }).systemMessage` as a `role: 'system'` message at index 0 of `upstreamMessages`, before the existing custom-prompt block. The block is wrapped in a `try/catch` so a profile-resolution failure cannot kill the stream.
- Mobile UI changes (in [src/web/src/components/Chat.jsx](../../src/web/src/components/Chat.jsx)):
  - The chat popover's **Prompt size** dropdown is now populated from `GET /api/prompt-profiles` instead of being hard-coded. Hard-coding the three options would have drifted the first time a profile was renamed.
  - A one-line description under the picker (`.chat-view__settings-hint`) shows the active profile's `description` and updates on every change.
  - The resolved system prompt is rendered as the first transcript message — a collapsible `.chat-msg--system` card fed by `GET /api/chats/:id/system-prompt`. It is refreshed in place whenever the prompt-size or custom prompt changes in the popover.
  - The chat meta line under the title no longer shows the profile; it shows only `trace on` (or nothing), because the profile now has a dedicated on-screen home in the transcript.
- `package.json → scripts.prepublishOnly` now also runs `node -c src/promptProfiles.js` so a syntax error in the new module blocks the publish.
- New smoke test: [scripts/test-prompt-profiles.js](../../scripts/test-prompt-profiles.js). 50 assertions covering the module's public surface, the resolution order, and the `GET /api/prompt-profiles` endpoint. Run with `node scripts/test-prompt-profiles.js`.

## Related

- Decisions: [docs/decisions.md §9](../decisions.md) (build order — "prompt-size profiles").
- Settings resolution: [App and project settings](./app-and-project-settings.md).
- Custom prompts: [Custom prompts](./custom-prompts.md) — the system-prompt layer that sits between the profile and the transcript.
- Chat UI: [Chat UI](./chat-ui.md) — where the picker lives.
