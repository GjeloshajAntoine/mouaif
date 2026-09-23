# Ask the user tool — let the model pause and ask structured questions — implementation notes

> Agent-facing reference for [`docs/features/ask-user-tool.md`](../../features/ask-user-tool.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

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

## Implementation notes

- Source: `src/tools/ask.js` (new module) — `SPEC` (the model-facing tool spec), `validateArgs(args)`, `buildResult({ choice, extra, options, multiSelect, cancelled })`, `clampExtra(value)`, and the length constants (`MAX_QUESTION_CHARS`, `MAX_OPTION_CHARS`, `MAX_EXTRA_CHARS`). There is no options-count cap; the `minItems: 2` floor is enforced in the JSON Schema and in `validateArgs`.
- `src/tools/authorization.js` adds `ask_user` to `NATIVE_TOOLS` and a new `BINARY_MODE_TOOLS` set. `normalizeConfig` clamps any legacy `allow` / `allowlist` value to `ask` for `ask_user`. `recordDecision(projectDir, chatId, callId, decision, payload)` accepts an optional structured `payload` and resolves `wait()` with `{ decision: 'allow', payload }` so the runner can fold the user's answer into the `tool` message. The `payload` parameter is generic — any future native tool can attach its own structured answer without a new endpoint.
- `src/ai.js` registers the spec alongside `shell` / `subagent` / file tools, validates the args before the gate runs (validation errors return an `EBADINPUT` `tool_result` without prompting the user), and emits a dedicated `ask_user_required` SSE event with the validated question + options. The wait() resolved value is captured into `callOptsAnswerPayload` and forwarded to the dispatcher. The subagent wrapper forwards `ask_user_required` with `parentTool: 'subagent'` so the chat UI can route the card into the subagent's live container.
- The `dispatchTool('ask_user', ...)` branch is a thin shim: it reads `callOpts.answerPayload`, builds the result with the canonical helper, and returns `{ ok, content, result }` in the same shape every other tool uses. No new dependencies, no new wire format.
- `src/index.js` extends the `/api/tools/authorization/decision` handler to forward the optional `payload` to `authGate.recordDecision`. The `/api/tools/list` and `/api/chats/:id/tool-preview` endpoints now advertise `ask_user` alongside the other native tools.
- The `Settings → Project → Tools` view (`frontend/src/components/SettingsProject.jsx`) shows an **Ask the user** row with a single `<select>` (`ask` / `off`). The mode auto-saves on change; there is no allowlist input.
- The chat UI (`frontend/src/components/chat/cards.js`) listens for `ask_user_required` events and renders a dedicated card with the question, the options as tap targets (44 px min height) inside a scrolling container, the always-on extra textarea, and the two action buttons. The styling lives in `frontend/src/features.css` under the `.tool-card--ask-user` block; the options container (`.tool-card__ask-options`) is capped at `13.5rem` and scrolls vertically so long option lists stay usable on a phone.
- **De-dupe is against the whole card family, not just other prompts.** Every mount path (owner SSE frame, follower live replay, nested subagent event, reconcile poll's pending snapshot) goes through `mountOverlayCard()` → `authCardGuard()` in `frontend/src/components/chat/overlay.js`. The guard matches `.tool-card--authorization[data-auth-call-id]`, `.tool-card--ask-user[data-auth-call-id]` **and** `[data-tool-id]` for the call id: the call's own `tool_call` / `tool_result` row card is a valid "already represented" match, so a prompt cannot be appended beside the card it answers when a later mount runs (the question was answered from another tab or the OS notification, so this tab's mounted card never saw the click and its `tool_call` card is already up). Guarding only the two prompt selectors left that reverse order as the surviving duplicate.
- Mobile-first layout: every interactive control is at least 44 px tall, the option cards are full-width with the label and a wrapped description, the textarea is monospaced-friendly and clamps to 1000 chars, and the action buttons are sticky-friendly (no absolute positioning, no hover-only affordances).
- New test: `scripts/test-ask-user.js` (40 assertions, covers the spec shape, validation rules, result-builder paths, the binary-mode gate, the `off` denial, the `ask` -> payload round trip via `recordDecision`, and the `getAuthorization` listing). No new runtime dependencies.

The question payload is validated and clamped in [src/tools/ask.js](../../../src/tools/ask.js); the answer rides the existing authorization-decision channel (`payload: { choice, extra }`) and is folded into the `tool` message by the dispatcher in [src/ai-stream.js](../../../src/ai-stream.js). The card itself is built in `askUserCard()` ([frontend/src/components/chat/cards.js](../../../frontend/src/components/chat/cards.js)).

Checks that cover this feature:

```bash
npm run test:ask-user      # payload shape, gate semantics, card de-dupe, head line
npm run fixture:ask-ui     # writes the card fixture to /tmp/mouaif-ask-ui
```

`fixture:ask-ui` renders the real card against the real stylesheet with a stubbed transcript, and exposes `window.fixture` (`live()`, `wrap()`, `many()`, `pair()`, `resolve()`, `late()`, `fresh()`, `dismissed()`, `cancel()`, `measure()`). Serve the written directory with any static server and open it at 390 px: `measure()` returns each option row's height, whether it sits inside the scroll container, whether its description is clipped, and each card's head line + summary slot — the last two are how the dismissal reads at a glance. `late()` is the duplicate order the de-dupe guard has to catch — the call's own card is already up and a late pending/replay mount tries to add the question beside it — while `fresh()` is the ordinary first render, which must still mount.

## Decisions

- [docs/decisions.md](../../decisions.md): §22 (ask the user tool), §17 (tool authorization).
