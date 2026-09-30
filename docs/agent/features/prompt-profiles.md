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

- New module: [src/promptProfiles.js](../../../src/promptProfiles.js). Public surface: `PROFILES`, `DEFAULT_PROFILE`, `isValidProfile`, `profileSystemMessage`, `describeProfile`, `listProfiles`, `resolveProfile`. The module exports a frozen `PROFILES` object and a `resolveProfile({ chat, projectDir })` helper that performs the layered lookup and never throws.
- Prompt text style: the three non-empty profiles compose by appending, so the shared core (`CORE_GUIDANCE`) is **byte-identical** across `very-small`, `average`, and `extensive`; `average = core + WORKFLOW_GUIDANCE` and `extensive = average + EXTENSIVE_GUIDANCE`. The core is grouped under four headings (`Answering`, `Acting`, `Editing`, `Reporting`) and every rule is affirmative, states the condition that triggers it, and names the tool argument or command form it depends on. `scripts/test-prompt-profiles.js` pins this shape — each core rule is asserted with a regex, the core is capped at 1800 chars, and the two `startsWith` composition checks fail if a profile stops extending its parent.
- Denied-operation guidance lives in the shared core: stop the denied operation, including attempts through another tool; ask for clarification or continue only with permitted work. This is a prompt-level instruction, not a new backend authorization boundary. Regression assertions cover it in all three non-empty profiles.
- New HTTP route: `GET /api/prompt-profiles` in [src/http-server.js](../../../src/http-server.js), handled before `/api/chats`.
- `handleChatStream` in [src/server-handlers-chats.js](../../../src/server-handlers-chats.js) prepends `promptProfiles.resolveProfile({ chat, projectDir }).systemMessage` as a `role: 'system'` message at index 0 of `upstreamMessages`, before the existing custom-prompt block. The block is wrapped in a `try/catch` so a profile-resolution failure cannot kill the stream.
- Mobile UI changes (in [frontend/src/components/chat/Chat.jsx](../../../frontend/src/components/chat/Chat.jsx)):
  - The prompt-size control is a **creation-time-only** full-width `<select class="input chat-view__setup">` mounted as the **first child of the transcript** (the message area, not the top bar). Three options: `Very small`, `Average`, `Extensive`. No title, no description, no preview — just the dropdown. `updateSetupVisibility()` mounts it only while `messagesRef.current.length === 0` and removes it from the DOM the moment the first message is sent — so the prompt size is chosen up front and is not a permanent fixture. The top bar (`.chat-view__head`) is unchanged: no prompt-size row, no preview row. There is no prompt-size select in the ⚙ popover.
  - The active profile is reflected by toggling the `selected` attribute on the matching `<option>` (in `updateSwitch`), not by setting `value` on the `<select>`. Preact can drop a `<select value=…>` on first mount when the option list isn't attached yet; `selected` is re-applied on every render and tracks state reliably.
  - The select is built imperatively by `buildSetupCard()` and prepended to the transcript by `renderTranscript()`. Its `change` event calls `setPromptSize(value)`, which is the same setter the now-removed popover used; the popover still exists for the *custom prompt* but no longer carries a prompt-size field.
  - The resolved system prompt is rendered as the first chat message — a `.chat-msg--system` card fed by `GET /api/chats/:id/system-prompt`. It is refreshed in place whenever the prompt size (switch) or custom prompt (popover) changes. On a brand-new chat it is inserted directly after the setup control; once the control is removed it becomes the first transcript child as before.
  - The chat meta line under the title no longer shows the profile; it shows only `trace on` (or nothing), because the profile now has a dedicated on-screen home in the transcript.
- New HTTP route in [src/index.js](../../../src/index.js): `GET /api/chats/:id/tool-preview`. It reuses the same tool-collection logic as `ai.streamChat` (native `shell` gated by `tools.shell.enabled`, plus `mcp.listComposedToolSpecs`) and applies `promptProfiles.reduceToolSpecs` with the chat's resolved profile, so the preview is byte-for-byte what the model is sent. For `very-small`, the preview shows `discover_tool` plus the compact per-tool entries — the fixed list the stream sends on every request of the turn.
- `package.json → scripts.prepublishOnly` now also runs `node -c src/promptProfiles.js` so a syntax error in the new module blocks the publish.
- New smoke test: [scripts/test-prompt-profiles.js](../../../scripts/test-prompt-profiles.js). 136 assertions covering the module's public surface, the resolution order, the per-profile tool reduction, and the `GET /api/prompt-profiles` endpoint. Run with `node scripts/test-prompt-profiles.js`. The suite is not on the `lint` chain.

`src/promptProfiles.js` composes each profile from shared text: Very small is the compact core, Average appends workflow guidance, and Extensive appends planning and examples to Average. This keeps common instructions identical and prevents larger profiles from drifting into contradictory behavior.

Profile IDs, the `average` default, settings resolution, and tool-schema reduction are unchanged. `GET /api/prompt-profiles` exposes the same metadata and composed `systemMessage` used by the chat pipeline and the custom-prompt editor's **Start from a default** / **Copy from default** actions. Saved custom prompts are independent copies and are not overwritten by built-in prompt updates.

Regression coverage in `scripts/test-prompt-profiles.js` checks shared rules, additive composition, size ordering, settings fallback, tool schemas, and HTTP responses using an isolated server on an ephemeral loopback port.
