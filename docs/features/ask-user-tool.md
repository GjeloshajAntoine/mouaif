# Ask the user tool — let the model pause and ask structured questions

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

`mouaif` ships a built-in `ask_user` tool the model can invoke. The tool lets the model pause the chat, ask the user a structured question with a list of options (**2 or more, no upper bound** — the card scrolls long lists), and wait for an answer. The user always has a free-form "extra answer" textarea alongside their pick, so the response is never constrained to the offered options. The selection + extra text is returned to the model as a single `tool` message; the chat picks up where it left off.

`ask_user` is the user-facing counterpart of `shell` and the file tools: the model can't predict the user's answer, so the authorization gate is binary (`off` / `ask`). There is no allowlist (the model can't enumerate user answers) and no `allow` mode (the user must always be the source of truth). The default is `ask`.

## Usage

### Enabling the tool

In **Settings → Project settings → Tools** (reachable from a project card's ⋯ menu → **Settings…**), the **Ask the user** row has a single `<select>` with two values:

| Value | Behavior |
|---|---|
| `ask` | The model can ask; the user is always shown the question card and must answer. (Default.) |
| `off` | The model cannot ask. Calls return `ETOOL_DISABLED` and the runner never runs. |

The value persists on the project file as `tools.ask_user.mode`. A project with no value falls back to the app default, then to `ask`. The shell enable switch is **not** duplicated for `ask_user` — the mode *is* the gate.

### In a chat

When the model decides to ask, the chat pauses and renders a dedicated **the model is asking** card on top of the live message. The card shows:

- the question (one sentence, model-supplied)
- the options (2+, no cap), each with a label and an optional one-line description; the list is capped at roughly 4.5 visible options and scrolls the rest so the extra textarea and action buttons stay on screen
- an **Add an extra answer** textarea (always available, never required)
- two buttons: **Send answer** and **Dismiss**

The user picks one option (or several, when `multiSelect: true`) and may attach a free-form note in the "extra" box. Tapping **Send answer** posts the selection + extra to the server, the chat continues, and the model receives a `tool` message shaped like:

```json
{
  "answered": true,
  "choice": "main",
  "extra": "use the trunk for hotfixes too",
  "options": [
    { "label": "main",  "value": "main" },
    { "label": "trunk", "value": "trunk" }
  ],
  "multiSelect": false,
  "cancelled": false
}
```

Tapping **Dismiss** resolves the call as `cancelled: true`. The model still gets a `tool` message, so the loop continues with a sensible default ("the user skipped my question; I'll assume …").

The wire shape on the SSE stream:

```
event: ask_user_required
data: { "chatId": "...", "callId": "call_abc123", "tool": "ask_user",
        "question": "Pick a default branch?",
        "options": [{ "label": "main",  "value": "main",  "description": "the canonical default" },
                    { "label": "trunk", "value": "trunk" }],
        "multiSelect": false,
        "projectDir": "..." }

event: tool_call
data: { "id": "call_abc123", "name": "ask_user", "args": { "question": "...", "options": [...], "multiSelect": false } }

event: tool_result
data: { "id": "call_abc123", "name": "ask_user", "ok": true,
        "result": { "answered": true, "choice": "main", "extra": "use the trunk for hotfixes too", "options": [...], "multiSelect": false, "cancelled": false } }
```

When a nested `subagent` call invokes `ask_user`, the same `ask_user_required` event fires with `parentTool: "subagent"`, and the chat UI routes the card into the subagent's live container instead of the top-level transcript.

### REST

The question card is driven by the existing authorization-decision endpoint, extended to carry a structured `payload`:

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| `POST` | `/api/tools/authorization/decision` | `{ projectDir, chatId, callId, decision: 'allow-once', payload: { choice, extra } }` | `{ ok: true }` |

The `payload` is optional. For every other tool (`shell`, `subagent`, the file tools, MCP) the existing `decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny'` enum is unchanged. `ask_user` ignores `allow-session` / `allow-always` — the user is always the source of truth — but the server still accepts the values for forward-compat.

### Programmatic (Node)

```js
const { validateArgs, buildResult, clampExtra } = require('mouaif/src/tools/ask.js');

const payload = validateArgs({
  question: 'Pick a default branch?',
  options: [
    { label: 'main',  value: 'main',  description: 'the canonical default' },
    { label: 'trunk', value: 'trunk' }
  ],
  multiSelect: false
});

const r = buildResult({
  choice: 'main',
  extra: clampExtra('use the trunk for hotfixes too'),
  options: payload.options,
  multiSelect: payload.multiSelect,
  cancelled: false
});
// r: { ok: true, content: '<json string>', result: { answered, choice, extra, options, multiSelect, cancelled } }
```

## Behavior

- **Always prompts.** A call always renders the question card and waits for the user. There is no `allow` mode — the model never decides on the user's behalf.
- **Binary authorization mode.** The mode enum is `{ off, ask }`. A hand-edited project file with a legacy `allow` or `allowlist` value is **clamped to `ask`** by the normalizer, so a future migration can't bypass the prompt.
- **Always-on extra answer.** The "extra" textarea is always present, never collapsed, and never optional in the UI — the user can attach a free-form note to their pick, refine it ("prefer `trunk`, but use `main` for releases"), or just write a sentence when the offered options don't fit.
- **2+ options, no upper bound.** The model must provide at least 2 options; fewer is rejected with `EBADINPUT`. There is no maximum — the card caps the visible list at roughly 4.5 options and scrolls the rest (`max-height: 13.5rem; overflow-y: auto` on `.tool-card__ask-options`), so a long list never pushes the extra textarea and action buttons off screen. Duplicate `value`s are rejected — `value` is the canonical answer the model sees, and duplicates would collapse options silently.
- **String lengths.** Question ≤ 500 chars, option label / value / description ≤ 120 chars each, extra ≤ 1000 chars. Everything is trimmed; an empty trimmed value fails validation.
- **Deny is a valid answer.** Tapping **Dismiss** resolves the call with `cancelled: true`. The model still receives a `tool` message and can decide what to do next (fall back to a free-form chat, stop, ask a different question, …). The same code path runs for an `EDENIED` thrown by the authorization module on a re-prompt.
- **Validation errors are surfaced, not prompted.** A bad question (too many options, duplicate value, missing label) returns an `EBADINPUT` `tool_result` directly — the user is never asked. The bug is on the model side; the model can self-correct on the next turn.
- **Subagent-aware.** A nested `subagent` that calls `ask_user` routes the card into the subagent's live container. The user answers, the answer rides the same authorization-decision endpoint, and the subagent's tool loop continues.
- **Multi-turn loop.** The result is fed back to the model as a `tool` message, so the model can chain calls (ask a question, read the answer, ask a follow-up, finish). There is no fixed tool-turn limit; cancellation comes from the user dismissing the card.
- **Audit log.** Every decision is appended to the per-chat NDJSON trace (decision §5) as a `system event` line (`{ type: 'auth_decision', tool: 'ask_user', callId, decision }`) when tracing is on. The audit line is not forwarded to the upstream.
- **No new runtime dependencies.** The runner is a plain function; the chat UI handles the input side. No third-party form libraries, no new SSE machinery — the existing `authorization_required` pipeline carries the question payload through a dedicated `ask_user_required` event.

## Implementation notes

- Source: `src/tools/ask.js` (new module) — `SPEC` (the model-facing tool spec), `validateArgs(args)`, `buildResult({ choice, extra, options, multiSelect, cancelled })`, `clampExtra(value)`, and the length constants (`MAX_QUESTION_CHARS`, `MAX_OPTION_CHARS`, `MAX_EXTRA_CHARS`). There is no options-count cap; the `minItems: 2` floor is enforced in the JSON Schema and in `validateArgs`.
- `src/tools/authorization.js` adds `ask_user` to `NATIVE_TOOLS` and a new `BINARY_MODE_TOOLS` set. `normalizeConfig` clamps any legacy `allow` / `allowlist` value to `ask` for `ask_user`. `recordDecision(projectDir, chatId, callId, decision, payload)` accepts an optional structured `payload` and resolves `wait()` with `{ decision: 'allow', payload }` so the runner can fold the user's answer into the `tool` message. The `payload` parameter is generic — any future native tool can attach its own structured answer without a new endpoint.
- `src/ai.js` registers the spec alongside `shell` / `subagent` / file tools, validates the args before the gate runs (validation errors return an `EBADINPUT` `tool_result` without prompting the user), and emits a dedicated `ask_user_required` SSE event with the validated question + options. The wait() resolved value is captured into `callOptsAnswerPayload` and forwarded to the dispatcher. The subagent wrapper forwards `ask_user_required` with `parentTool: 'subagent'` so the chat UI can route the card into the subagent's live container.
- The `dispatchTool('ask_user', ...)` branch is a thin shim: it reads `callOpts.answerPayload`, builds the result with the canonical helper, and returns `{ ok, content, result }` in the same shape every other tool uses. No new dependencies, no new wire format.
- `src/index.js` extends the `/api/tools/authorization/decision` handler to forward the optional `payload` to `authGate.recordDecision`. The `/api/tools/list` and `/api/chats/:id/tool-preview` endpoints now advertise `ask_user` alongside the other native tools.
- The `Settings → Project → Tools` view (`src/web/src/components/SettingsProject.jsx`) shows an **Ask the user** row with a single `<select>` (`ask` / `off`). The mode auto-saves on change; there is no allowlist input.
- The chat UI (`src/web/src/components/chat/cards.js`) listens for `ask_user_required` events and renders a dedicated card with the question, the options as tap targets (44 px min height) inside a scrolling container, the always-on extra textarea, and the two action buttons. The styling lives in `src/web/src/features.css` under the `.tool-card--ask-user` block; the options container (`.tool-card__ask-options`) is capped at `13.5rem` and scrolls vertically so long option lists stay usable on a phone.
- Mobile-first layout: every interactive control is at least 44 px tall, the option cards are full-width with the label and a wrapped description, the textarea is monospaced-friendly and clamps to 1000 chars, and the action buttons are sticky-friendly (no absolute positioning, no hover-only affordances).
- New test: `scripts/test-ask-user.js` (40 assertions, covers the spec shape, validation rules, result-builder paths, the binary-mode gate, the `off` denial, the `ask` -> payload round trip via `recordDecision`, and the `getAuthorization` listing). No new runtime dependencies.

## Related

- [docs/features/ai-client.md](./ai-client.md) — `tool_call`, `tool_result`, and the new `ask_user_required` SSE event names.
- [docs/features/tool-authorization.md](./tool-authorization.md) — every ask_user call passes through the same authorization gate; the new binary-mode set is a strict subset.
- [docs/features/shell-tool.md](./shell-tool.md) — sibling tool that also uses the gate; the `ask_user` runner mirrors its "always return a typed error" contract.
- [docs/features/file-tools.md](./file-tools.md) — sibling native tool; the spec registration and dispatch flow are identical.
- Decision: [docs/decisions.md §22](../decisions.md) (this feature) and §17 (tool authorization).
