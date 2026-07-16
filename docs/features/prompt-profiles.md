# Prompt-size profiles

## Overview

`mouaif` ships three hand-written system prompts — `very-small`, `average`, and `extensive` — that the chat stream prepends to the upstream `messages` array, in front of any custom prompt and the transcript. Every chat carries a `promptSize` field, so each chat can pick its own profile. The same field is also stored on the project (`<projectDir>/.mouaif.json`) and the app store, so projects and the app itself can pin a default. The active profile is resolved at request time, per the same `defaults → app → project → chat` order as the rest of the settings stack.

This feature implements the "Three prompt-size profiles" entry in `.github/copilot-instructions.md` §4. The profile text is intentionally a single static block per size; the goal is **predictability** and **a small prompt budget**, not a per-provider conversation about identity.

## Usage

### Picking a profile

- **In the chat, at creation time only** — open a fresh (empty) chat. The **transcript's first child** is a `.chat-view__setup` card (it lives in the message area, not the top bar) that contains a "SETUP" role label, a one-line title, a short explainer, a segmented `S` / `M` / `L` switch, and a **tool-declaration preview** directly beneath it showing exactly what the active profile sends upstream (how many tools, and whether each carries its full parameter schema or just a name + short description). The System-prompt message sits below the setup card so the user sees the resolved prompt they just configured. Tapping a segment `PATCH`es `/api/chats/:id { promptSize: '…' }` and refreshes both the System card and the preview. **The setup card is removed from the transcript as soon as the first message is sent** — the prompt size is fixed for the life of the chat, and the top bar stays clean (no permanent prompt-size widget). There is no prompt-size control in the ⚙ popover.
- **For the whole project** — set `promptSize` under the project in `<projectDir>/.mouaif.json` (e.g. `{ "promptSize": "extensive" }`). New chats inherit it. Existing chats are unaffected unless they have their own override.
- **App-wide default** — `PUT /api/settings/app { "promptSize": "very-small" }`, or change the **Default prompt size** dropdown in **Settings → Defaults**. Used when the project has no value.

### Reading the active profile

The resolved system prompt (the active profile's text, plus any custom prompt) is rendered as a **"System prompt" card at the top of the transcript** — the first chat-message of every chat. It sits directly below the setup card on a brand-new chat, so the user can see the resolved prompt they just configured. Tap it to expand and read exactly what the model is being sent. While the chat is still empty, the setup card above it also shows the active profile and its concrete effect on the tool budget; the setup card is removed from the DOM the moment the first message is sent. The prompt-size is not echoed on the chat meta line (which shows only the trace state). The app default is in **Settings → App defaults**.

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
  - `GET /api/prompt-profiles` returns `{ default, profiles: [{ id, label, description, summary, systemMessage }, …] }`.
  - `GET /api/chats/:id/system-prompt?projectDir=…` returns `{ profile, prompt, text }` — the **resolved** system context for that specific chat (the profile it will actually use plus its custom prompt, if any). `text` is the concatenation in upstream order. The chat UI uses this to render the first-message system-prompt card, so the card always reflects what `handleChatStream` will send.
  - `GET /api/chats/:id/tool-preview?projectDir=…` returns `{ profile, reduced, shellEnabled, count, tools: [{ name, description, hasSchema, params }] }` — the **tool-declaration state** for the chat's resolved profile. The server collects the tools exactly as `ai.streamChat` does (native `shell`, gated by `tools.shell.enabled`, plus ready MCP servers), then applies the same `reduceToolSpecs` reduction the stream will apply, so the preview is always what the model actually gets. `reduced` is `true` for `very-small` (schemas stripped); each tool reports `hasSchema` and the `params` it advertises. The chat UI renders this as the creation-time preview under the S/M/L switch.

## HTTP surface

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/api/prompt-profiles` | — | `{ default, profiles: [...] }` |
| GET | `/api/chats/:id/system-prompt` | `?projectDir=` | `{ profile, prompt, text }` |
| GET | `/api/chats/:id/tool-preview` | `?projectDir=` | `{ profile, reduced, shellEnabled, count, tools }` |

The chat's profile is set with the existing `PATCH /api/chats/:id { promptSize }` and is read back on `GET /api/chats/:id`. The project's profile is set with `PUT /api/settings/project { projectDir, promptSize }`. The app's default is set with `PUT /api/settings/app { promptSize }`.

## Implementation notes

- New module: [src/promptProfiles.js](../../src/promptProfiles.js). Public surface: `PROFILES`, `DEFAULT_PROFILE`, `isValidProfile`, `profileSystemMessage`, `describeProfile`, `listProfiles`, `resolveProfile`. The module exports a frozen `PROFILES` object and a `resolveProfile({ chat, projectDir })` helper that performs the layered lookup and never throws.
- New HTTP route in [src/index.js](../../src/index.js): `GET /api/prompt-profiles`. Handled in the main router, before `/api/chats`.
- `handleChatStream` in [src/index.js](../../src/index.js) now prepends `promptProfiles.resolveProfile({ chat, projectDir }).systemMessage` as a `role: 'system'` message at index 0 of `upstreamMessages`, before the existing custom-prompt block. The block is wrapped in a `try/catch` so a profile-resolution failure cannot kill the stream.
- Mobile UI changes (in [src/web/src/components/Chat.jsx](../../src/web/src/components/Chat.jsx)):
  - The prompt-size control is a **creation-time-only** setup card (`.chat-view__setup`) mounted as the **first child of the transcript** (the message area, not the top bar). It contains a "SETUP" role label, a one-line title, a short explainer, a segmented `S` / `M` / `L` switch (`.chat-view__switch`), and a tool-declaration preview (`.chat-view__toolprev`) beneath it. `updateSetupVisibility()` mounts the card only while `messagesRef.current.length === 0` and removes it from the DOM the moment the first message is sent — so the prompt size is chosen up front and is not a permanent fixture. The top bar (`.chat-view__head`) is unchanged: no prompt-size row, no preview row. There is no prompt-size select in the ⚙ popover.
  - The preview is rendered by `loadToolPreview()` from `GET /api/chats/:id/tool-preview`: a summary line (`<label>: N tools — full specs | no schemas`) plus one row per tool (name, a `params`/`no schema` chip, and the exact description sent upstream). It re-fetches on every switch tap via the shared `setPromptSize()`. The preview host is queried through `setupCardRef.current.querySelector('.chat-view__toolprev')`, so the preview dies with the card.
  - The resolved system prompt is rendered as the first chat message — a `.chat-msg--system` card fed by `GET /api/chats/:id/system-prompt`. It is refreshed in place whenever the prompt size (switch) or custom prompt (popover) changes. On a brand-new chat it is inserted directly after the setup card; once the setup card is removed it becomes the first transcript child as before.
  - The chat meta line under the title no longer shows the profile; it shows only `trace on` (or nothing), because the profile now has a dedicated on-screen home in the transcript.
- New HTTP route in [src/index.js](../../src/index.js): `GET /api/chats/:id/tool-preview`. It reuses the same tool-collection logic as `ai.streamChat` (native `shell` gated by `tools.shell.enabled`, plus `mcp.listComposedToolSpecs`) and applies `promptProfiles.reduceToolSpecs` with the chat's resolved profile, so the preview is byte-for-byte what the model is sent.
- `package.json → scripts.prepublishOnly` now also runs `node -c src/promptProfiles.js` so a syntax error in the new module blocks the publish.
- New smoke test: [scripts/test-prompt-profiles.js](../../scripts/test-prompt-profiles.js). 50 assertions covering the module's public surface, the resolution order, and the `GET /api/prompt-profiles` endpoint. Run with `node scripts/test-prompt-profiles.js`.

## Related

- Decisions: [docs/decisions.md §9](../decisions.md) (build order — "prompt-size profiles").
- Settings resolution: [App and project settings](./app-and-project-settings.md).
- Custom prompts: [Custom prompts](./custom-prompts.md) — the system-prompt layer that sits between the profile and the transcript.
- Chat UI: [Chat UI](./chat-ui.md) — where the picker lives.
