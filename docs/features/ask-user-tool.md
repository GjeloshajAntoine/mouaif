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
- the options (2+, no cap), each a full-width 48 px+ tap row with a radio mark (or a checkbox mark and a "Pick one or more" hint when `multiSelect: true`), a label, and an optional description; the list is capped at `min(45dvh, 18rem)` and scrolls the rest so the note field and action buttons stay on screen, with a bottom fade while more options are below
- a **Note for the model (optional)** textarea (always available, never required; 16 px text so iOS does not zoom on focus)
- two buttons: the primary action and **Dismiss**. The primary button reads **Pick an option** (disabled) until something is chosen, **Send answer** once an option is picked, and **Send note** when only a note is typed — a note on its own is sent as the answer, not dropped

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
- **A typed note is never discarded.** Tapping the primary button with no option picked used to resolve the call as a dismissal, which threw away whatever the user had typed in the note box. The button is now disabled when there is nothing to send, and a note with no option is sent as an answer (`choice: ""` or `[]`, `extra: "<note>"`). Only **Dismiss** produces `cancelled: true`.
- **The card is not collapsible, so it has no chevron.** The head shows a question icon instead of the transcript's collapse chevron, which did nothing on tap here. The body is a real flex column with even spacing (a `display: block` override used to drop every `gap`, which pressed the question against the chips and the note field against the list). Presets, options, and action buttons are all at least 44 px tall.
- **Option rows keep their height.** The option list is a capped, scrollable column (`max-height: min(45dvh, 18rem)`), so its rows are explicitly non-shrinkable (`flex: 0 0 auto`). Without that, a list taller than the cap squashed every row to fit the cap instead of scrolling: a label + description row collapsed, its description overflowed the row (and the list), and because the overflow was painted rather than laid out it never raised `scrollHeight` — the text could not even be scrolled into view.
- **Collapsed cards read as the question.** The persisted card's head line is the question (`formatToolArgs`) and its summary slot is the recorded answer — `main`, `2 choices` for a multi-select pick, or `dismissed`. Without a formatter for `ask_user` the head line was the raw `JSON.stringify` of `args`, truncated at 220 chars in the middle of an option description.
- **A dismissal reads as a dismissal, not a failure.** The runner builds a dismissed question as `ok: false` with `cancelled: true` (src/tools/ask.js `buildResult`), and both summary call sites only asked the formatter for a result that was ok — so the `dismissed` slot above was unreachable and the collapsed card showed a red error dot with no explanation for something the user chose. The summary is now requested for a non-ok result when `isExpectedToolFailure` says the user caused it, which today means `ask_user` answered Dismiss; the dot stays the error colour, since a dismissal is still not success. A genuine failure (a validation `EBADINPUT`, an `ENOANSWER`) still carries no summary.
- **Binary authorization mode.** The mode enum is `{ off, ask }`. A hand-edited project file with a legacy `allow` or `allowlist` value is **clamped to `ask`** by the normalizer, so a future migration can't bypass the prompt.
- **Always-on extra answer.** The "extra" note textarea is always present and never collapsed — the user can attach a free-form note to their pick, refine it ("prefer `trunk`, but use `main` for releases"), or just write a sentence when the offered options don't fit.
- **2+ options, no upper bound.** The model must provide at least 2 options; fewer is rejected with `EBADINPUT`. There is no maximum — the card caps the visible list (`max-height: min(45dvh, 18rem); overflow-y: auto` on `.tool-card__ask-options`) and scrolls the rest, so a long list never pushes the extra textarea and action buttons off screen. Duplicate `value`s are rejected — `value` is the canonical answer the model sees, and duplicates would collapse options silently.
- **String lengths.** Question ≤ 500 chars, option label / value / description ≤ 120 chars each, extra ≤ 1000 chars. Everything is trimmed; an empty trimmed value fails validation.
- **Deny is a valid answer.** Tapping **Dismiss** resolves the call with `cancelled: true`. The model still receives a `tool` message and can decide what to do next (fall back to a free-form chat, stop, ask a different question, …). The same code path runs for an `EDENIED` thrown by the authorization module on a re-prompt.
- **Validation errors are surfaced, not prompted.** A bad question (too many options, duplicate value, missing label) returns an `EBADINPUT` `tool_result` directly — the user is never asked. The bug is on the model side; the model can self-correct on the next turn.
- **Subagent-aware.** A nested `subagent` that calls `ask_user` routes the card into the subagent's live container. The user answers, the answer rides the same authorization-decision endpoint, and the subagent's tool loop continues.
- **Multi-turn loop.** The result is fed back to the model as a `tool` message, so the model can chain calls (ask a question, read the answer, ask a follow-up, finish). There is no fixed tool-turn limit; cancellation comes from the user dismissing the card.
- **Audit log.** Every decision is appended to the per-chat NDJSON [trace](./trace.md) as a `system event` line (`{ type: 'auth_decision', tool: 'ask_user', callId, decision }`) when tracing is on. The audit line is not forwarded to the upstream.
- **No new runtime dependencies.** The runner is a plain function; the chat UI handles the input side. No third-party form libraries, no new SSE machinery — the existing `authorization_required` pipeline carries the question payload through a dedicated `ask_user_required` event.

## Related

- [docs/features/ai-client.md](./ai-client.md) — `tool_call`, `tool_result`, and the new `ask_user_required` SSE event names.
- [docs/features/tool-authorization.md](./tool-authorization.md) — every ask_user call passes through the same authorization gate; the new binary-mode set is a strict subset.
- [docs/features/shell-tool.md](./shell-tool.md) — sibling tool that also uses the gate; the `ask_user` runner mirrors its "always return a typed error" contract.
- [docs/features/file-tools.md](./file-tools.md) — sibling native tool; the spec registration and dispatch flow are identical.
