# Prompt-size profiles — implementation notes

> Agent-facing reference for [`docs/features/prompt-profiles.md`](../../features/prompt-profiles.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## HTTP surface

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/api/prompt-profiles` | — | `{ default, profiles: [...] }` |
| GET | `/api/chats/:id/system-prompt` | `?projectDir=` | `{ profile, prompt, text }` |
| GET | `/api/chats/:id/tool-preview` | `?projectDir=` | `{ profile, reduced, shellEnabled, count, tools }` |

The chat's profile is set with the existing `PATCH /api/chats/:id { promptSize }` and is read back on `GET /api/chats/:id`. The project's profile is set with `PUT /api/settings/project { projectDir, promptSize }`. The app's default is set with `PUT /api/settings/app { promptSize }`.

## Implementation notes

- New module: [src/promptProfiles.js](../../src/promptProfiles.js). Public surface: `PROFILES`, `DEFAULT_PROFILE`, `isValidProfile`, `profileSystemMessage`, `describeProfile`, `listProfiles`, `resolveProfile`. The module exports a frozen `PROFILES` object and a `resolveProfile({ chat, projectDir })` helper that performs the layered lookup and never throws.
- New HTTP route: `GET /api/prompt-profiles` in [src/http-server.js](../../src/http-server.js), handled before `/api/chats`.
- `handleChatStream` in [src/server-handlers-chats.js](../../src/server-handlers-chats.js) prepends `promptProfiles.resolveProfile({ chat, projectDir }).systemMessage` as a `role: 'system'` message at index 0 of `upstreamMessages`, before the existing custom-prompt block. The block is wrapped in a `try/catch` so a profile-resolution failure cannot kill the stream.
- Mobile UI changes (in [frontend/src/components/chat/Chat.jsx](../../frontend/src/components/chat/Chat.jsx)):
  - The prompt-size control is a **creation-time-only** full-width `<select class="input chat-view__setup">` mounted as the **first child of the transcript** (the message area, not the top bar). Three options: `Very small`, `Average`, `Extensive`. No title, no description, no preview — just the dropdown. `updateSetupVisibility()` mounts it only while `messagesRef.current.length === 0` and removes it from the DOM the moment the first message is sent — so the prompt size is chosen up front and is not a permanent fixture. The top bar (`.chat-view__head`) is unchanged: no prompt-size row, no preview row. There is no prompt-size select in the ⚙ popover.
  - The active profile is reflected by toggling the `selected` attribute on the matching `<option>` (in `updateSwitch`), not by setting `value` on the `<select>`. Preact can drop a `<select value=…>` on first mount when the option list isn't attached yet; `selected` is re-applied on every render and tracks state reliably.
  - The select is built imperatively by `buildSetupCard()` and prepended to the transcript by `renderTranscript()`. Its `change` event calls `setPromptSize(value)`, which is the same setter the now-removed popover used; the popover still exists for the *custom prompt* but no longer carries a prompt-size field.
  - The resolved system prompt is rendered as the first chat message — a `.chat-msg--system` card fed by `GET /api/chats/:id/system-prompt`. It is refreshed in place whenever the prompt size (switch) or custom prompt (popover) changes. On a brand-new chat it is inserted directly after the setup control; once the control is removed it becomes the first transcript child as before.
  - The chat meta line under the title no longer shows the profile; it shows only `trace on` (or nothing), because the profile now has a dedicated on-screen home in the transcript.
- New HTTP route in [src/index.js](../../src/index.js): `GET /api/chats/:id/tool-preview`. It reuses the same tool-collection logic as `ai.streamChat` (native `shell` gated by `tools.shell.enabled`, plus `mcp.listComposedToolSpecs`) and applies `promptProfiles.reduceToolSpecs` with the chat's resolved profile, so the preview is byte-for-byte what the model is sent. For `very-small`, the preview shows `discover_tool` plus the compact per-tool entries — the fixed list the stream sends on every request of the turn.
- `package.json → scripts.prepublishOnly` now also runs `node -c src/promptProfiles.js` so a syntax error in the new module blocks the publish.
- New smoke test: [scripts/test-prompt-profiles.js](../../scripts/test-prompt-profiles.js). 50 assertions covering the module's public surface, the resolution order, and the `GET /api/prompt-profiles` endpoint. Run with `node scripts/test-prompt-profiles.js`.
