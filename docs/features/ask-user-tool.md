# Ask the user tool — let the model pause and ask structured questions

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

Presets, when the model supplies them, render as chips above the option list: tapping one submits that answer immediately, without showing the options.

Once the call settles, the persisted transcript shows it as a collapsed tool card whose head line is the question and whose trailing slot is the recorded answer (`main`, `2 choices`, or `dismissed`).

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

## Behavior

- **Always prompts.** A call always renders the question card and waits for the user. There is no `allow` mode — the model never decides on the user's behalf.
- **One card per question.** The question card is mounted outside the message flow (SSE frame, follower live stream, pending-auth poll), and the call's own `tool_call` / `tool_result` frames are persisted rows. Answering from the OS notification or from a second tab means the mounted card never sees the click, so the call frame used to append a *second* card under the same tool id — the same question on screen twice, with the `tool_result` folded into the first match while the other stayed on "running". `appendToolCallCard` now removes any standing `ask_user` / `authorization` overlay card carrying that call id before it appends, so the call card always supersedes the prompt it answers.
- **Rendered once, at the correct position.** `ask_user_required` and `authorization_required` share the same pending queue that the reconcile poll drains, so the chat UI de-dupes by `callId` and never mounts a card twice (an SSE frame and a later poll could otherwise render duplicates). Both card types also wait for any in-flight chunked transcript render before mounting, so the card always lands at the bottom of the presented rows instead of being stranded mid-transcript — ask_user and the generic authorization card move together.
- **A prompt never mounts beside the card of its own call.** The de-dupe above only looked for another *prompt* carrying that `callId`, which left the reverse order open: the call's `tool_call` / `tool_result` row card is already on screen (a tail sync re-rendered it, or the question was answered from the OS notification / a second tab so this tab never saw the click) and a later mount path then ran — the pending-auth poll, or a live-replay reconnect. The prompt was appended next to its own call card, so one question appeared twice: the answered card plus a live, unanswered-looking copy. `authCardGuard()` now treats *any* tool card carrying that call id as the existing representation of the call — overlay cards stamp `data-auth-call-id`, every tool card stamps `data-tool-id` — so the late prompt mount is a no-op and the call card survives alone.
- **Cancel clears every prompt.** The chat's **Stop** path drops both card kinds — previously it only removed authorization cards, so an unanswered question stayed on screen after a cancel and could then be rendered a second time next to its own call card.
- **Option rows keep their height.** The option list is a capped, scrollable column (`max-height: 13.5rem`), so its rows are explicitly non-shrinkable (`flex: 0 0 auto`). Without that, a list taller than the cap squashed every row to fit the cap instead of scrolling: a label + description row collapsed, its description overflowed the row (and the list), and because the overflow was painted rather than laid out it never raised `scrollHeight` — the text could not even be scrolled into view.
- **Collapsed cards read as the question.** The persisted card's head line is the question (`formatToolArgs`) and its summary slot is the recorded answer — `main`, `2 choices` for a multi-select pick, or `dismissed`. Without a formatter for `ask_user` the head line was the raw `JSON.stringify` of `args`, truncated at 220 chars in the middle of an option description.
- **A dismissal reads as a dismissal, not a failure.** The runner builds a dismissed question as `ok: false` with `cancelled: true` (src/tools/ask.js `buildResult`), and both summary call sites only asked the formatter for a result that was ok — so the `dismissed` slot above was unreachable and the collapsed card showed a red error dot with no explanation for something the user chose. The summary is now requested for a non-ok result when `isExpectedToolFailure` says the user caused it, which today means `ask_user` answered Dismiss; the dot stays the error colour, since a dismissal is still not success. A genuine failure (a validation `EBADINPUT`, an `ENOANSWER`) still carries no summary.
- **Binary authorization mode.** The mode enum is `{ off, ask }`. A hand-edited project file with a legacy `allow` or `allowlist` value is **clamped to `ask`** by the normalizer, so a future migration can't bypass the prompt.
- **Always-on extra answer.** The "extra" textarea is always present, never collapsed, and never optional in the UI — the user can attach a free-form note to their pick, refine it ("prefer `trunk`, but use `main` for releases"), or just write a sentence when the offered options don't fit.
- **2+ options, no upper bound.** The model must provide at least 2 options; fewer is rejected with `EBADINPUT`. There is no maximum — the card caps the visible list at roughly 4.5 options and scrolls the rest (`max-height: 13.5rem; overflow-y: auto` on `.tool-card__ask-options`), so a long list never pushes the extra textarea and action buttons off screen. Duplicate `value`s are rejected — `value` is the canonical answer the model sees, and duplicates would collapse options silently.
- **String lengths.** Question ≤ 500 chars, option label / value / description ≤ 120 chars each, extra ≤ 1000 chars. Everything is trimmed; an empty trimmed value fails validation.
- **Deny is a valid answer.** Tapping **Dismiss** resolves the call with `cancelled: true`. The model still receives a `tool` message and can decide what to do next (fall back to a free-form chat, stop, ask a different question, …). The same code path runs for an `EDENIED` thrown by the authorization module on a re-prompt.
- **Validation errors are surfaced, not prompted.** A bad question (too many options, duplicate value, missing label) returns an `EBADINPUT` `tool_result` directly — the user is never asked. The bug is on the model side; the model can self-correct on the next turn.
- **Subagent-aware.** A nested `subagent` that calls `ask_user` routes the card into the subagent's live container. The user answers, the answer rides the same authorization-decision endpoint, and the subagent's tool loop continues.
- **Multi-turn loop.** The result is fed back to the model as a `tool` message, so the model can chain calls (ask a question, read the answer, ask a follow-up, finish). There is no fixed tool-turn limit; cancellation comes from the user dismissing the card.
- **Audit log.** Every decision is appended to the per-chat NDJSON [trace](./trace.md) as a `system event` line (`{ type: 'auth_decision', tool: 'ask_user', callId, decision }`) when tracing is on. The audit line is not forwarded to the upstream.
- **No new runtime dependencies.** The runner is a plain function; the chat UI handles the input side. No third-party form libraries, no new SSE machinery — the existing `authorization_required` pipeline carries the question payload through a dedicated `ask_user_required` event.

## Implementation notes

The question payload is validated and clamped in [src/tools/ask.js](../../src/tools/ask.js); the answer rides the existing authorization-decision channel (`payload: { choice, extra }`) and is folded into the `tool` message by the dispatcher in [src/ai-stream.js](../../src/ai-stream.js). The card itself is built in `askUserCard()` ([frontend/src/components/chat/cards.js](../../frontend/src/components/chat/cards.js)).

Checks that cover this feature:

```bash
npm run test:ask-user      # payload shape, gate semantics, card de-dupe, head line
npm run fixture:ask-ui     # writes the card fixture to /tmp/mouaif-ask-ui
```

`fixture:ask-ui` renders the real card against the real stylesheet with a stubbed transcript, and exposes `window.fixture` (`live()`, `wrap()`, `many()`, `pair()`, `resolve()`, `late()`, `fresh()`, `dismissed()`, `cancel()`, `measure()`). Serve the written directory with any static server and open it at 390 px: `measure()` returns each option row's height, whether it sits inside the scroll container, whether its description is clipped, and each card's head line + summary slot — the last two are how the dismissal reads at a glance. `late()` is the duplicate order the de-dupe guard has to catch — the call's own card is already up and a late pending/replay mount tries to add the question beside it — while `fresh()` is the ordinary first render, which must still mount.

## Related

- [docs/features/ai-client.md](./ai-client.md) — `tool_call`, `tool_result`, and the new `ask_user_required` SSE event names.
- [docs/features/tool-authorization.md](./tool-authorization.md) — every ask_user call passes through the same authorization gate; the new binary-mode set is a strict subset.
- [docs/features/shell-tool.md](./shell-tool.md) — sibling tool that also uses the gate; the `ask_user` runner mirrors its "always return a typed error" contract.
- [docs/features/file-tools.md](./file-tools.md) — sibling native tool; the spec registration and dispatch flow are identical.
