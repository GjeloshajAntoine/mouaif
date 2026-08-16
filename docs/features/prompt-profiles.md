# Prompt-size profiles

## Overview

`mouaif` ships three hand-written system prompts — `very-small`, `average`, and `extensive` — that the chat stream prepends to the upstream `messages` array, in front of any custom prompt and the transcript. Every chat carries a `promptSize` field, so each chat can pick its own profile. The same field is also stored on the project (`<projectDir>/.mouaif.json`) and the app store, so projects and the app itself can pin a default. The active profile is resolved at request time, per the same `defaults → app → project → chat` order as the rest of the settings stack.

This feature implements the "Three prompt-size profiles" entry in `.github/copilot-instructions.md` §4. The profile text is intentionally a single static block per size; the goal is **predictability** and **a small prompt budget**, not a per-provider conversation about identity. The `average` profile keeps the mouaif identity, practical answer rules, and the agentic tool-loop rules (read/edit/run loop, non-interactive shell, progress reporting, ask-when-unclear), while avoiding project-settings and server details that rarely change model behavior.

## Usage

### Picking a profile

- **In the chat, at creation time only** — open a fresh (empty) chat. The **transcript's first child** is a single full-width `<select class="input chat-view__setup">` with three options (`Very small`, `Average`, `Extensive`). No title, no description, no preview. It lives in the message area, not the top bar. The System-prompt message sits directly below it so the user sees the resolved prompt they just configured. Picking an option `PATCH`es `/api/chats/:id { promptSize: '…' }` and updates the System message. **The control is removed from the transcript as soon as the first message is sent** — the prompt size is fixed for the life of the chat, and the top bar stays clean (no permanent prompt-size widget). There is no prompt-size control in the ⚙ popover.
- **For the whole project** — set `promptSize` under the project in `<projectDir>/.mouaif.json` (e.g. `{ "promptSize": "extensive" }`). New chats inherit it. Existing chats are unaffected unless they have their own override.
- **App-wide default** — `PUT /api/settings/app { "promptSize": "very-small" }`, or change the **Default prompt size** dropdown in **Settings → Defaults**. Used when the project has no value.

### Reading the active profile

The resolved system prompt (the active profile's text, plus any custom prompt) is rendered as a **"System prompt" card at the top of the transcript** — the first chat-message of every chat. It sits directly below the prompt-size `<select>` on a brand-new chat, so the user can see the resolved prompt they just configured. Tap it to expand and read exactly what the model is being sent. The setup control above it is removed from the DOM the moment the first message is sent. The prompt-size is not echoed on the chat meta line (which shows only the trace state). The app default is in **Settings → App defaults**.

### The three profiles

| ID | Label | When to use it |
|---|---|---|
| `very-small` | Very small | Tight context budgets, low-latency replies, or when the model is already well-aligned and you want a tiny floor prompt. |
| `average` | Average | The recommended default. Identity + concise guidance on how to answer + agentic tool-loop rules (read/edit/run loop, non-interactive shell, progress reporting via `report_progress` / `task`, ask when unclear). |
| `extensive` | Extensive | When you want the model to be deliberate, follow the trace / tool guidelines, and use worked examples. |

The `average` and `extensive` profiles both tell the model to call `report_progress` periodically on multi-step or slow tasks **and to send a final `status: "completed"` report** when the work is done — so long agentic turns surface a live progress card plus the per-chat completion notification, rather than ending with no progress at all.

The default is `average`. The chat, the project, and the app can each override it; the most specific one wins.

## Behavior

- **Where the profile lives in the message list**: `handleChatStream` builds the upstream `messages` array in this order — (1) the active profile's system message, (2) the chat's custom prompt (if any), (3) the transcript (user + assistant turns). The profile is **always** present, even when the chat has no custom prompt and no prior messages.
- **Resolution order**: `chat.promptSize → resolved project.promptSize → app.promptSize → 'average'`. An invalid or missing value falls through to the next layer; nothing throws. The function is safe to call on a half-loaded chat record.
- **Tool-declaration reduction** (the core of this feature): the profile controls how much of each tool is advertised to the model, not just the system-prompt text.
  - `very-small`: the advertised list is `discover_tool` plus one **compact** entry (name + short description, no `parameters` schema) per available tool. The list is **fixed for the whole turn** — it does not grow after a `discover_tool` call, because a growing tool list would change the Anthropic cached prefix (system + tools) between tool-loop requests and invalidate the warm cache on every round. The model calls `discover_tool({ toolName })` to get one chosen tool's full description and `parameters` on demand.
  - `average` / `extensive`: the **full** tool specs (name + full description + `parameters`).
  This is done by `promptProfiles.reduceToolSpecs(specs, profileId, { discoveredToolNames })`, applied in `src/ai.js` after both tool sources (native `shell` + MCP) are collected, so every advertised tool is reduced uniformly. The reduction is driven by the resolved profile id that `handleChatStream` passes to `streamChat` as `opts.promptSize`.
- **Static text**: the three system prompts are baked into the build. They are not per-provider. The tool list is injected separately and reduced per the rule above.
- **Custom prompts are layered on top, not instead of**. A chat with `promptId: 'review-mode'` sends `[profile, custom-prompt, …transcript]`. The custom prompt's own instructions say "where they do not conflict with the active profile", so the layering is intentional, not accidental.
- **Read endpoints**:
  - `GET /api/prompt-profiles` returns `{ default, profiles: [{ id, label, description, summary, systemMessage }, …] }`.
  - `GET /api/chats/:id/system-prompt?projectDir=…` returns `{ profile, prompt, text }` — the **resolved** system context for that specific chat (the profile it will actually use plus its custom prompt, if any). `text` is the concatenation in upstream order. The chat UI uses this to render the first-message system-prompt card, so the card always reflects what `handleChatStream` will send.
  - `GET /api/chats/:id/tool-preview?projectDir=…` returns `{ profile, reduced, shellEnabled, count, tools: [{ name, description, hasSchema, params }] }` — the **tool-declaration state** for the chat's resolved profile. The server collects the tools exactly as `ai.streamChat` does (native `shell`, gated by `tools.shell.enabled`, plus ready MCP servers), then applies the same `reduceToolSpecs` reduction the stream will apply, so the preview is always what the model actually gets. `reduced` is `true` for `very-small`; the preview contains `discover_tool` plus a compact entry per tool (only `discover_tool` has `hasSchema: true`). The chat UI renders this as the creation-time preview under the S/M/L switch.

## Related

- Decisions: [docs/decisions.md §9](../decisions.md) (build order — "prompt-size profiles").
- Settings resolution: [App and project settings](./app-and-project-settings.md).
- Custom prompts: [Custom prompts](./custom-prompts.md) — the system-prompt layer that sits between the profile and the transcript.
- Chat UI: [Chat UI](./chat-ui.md) — where the picker lives.
