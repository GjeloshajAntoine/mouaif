# Subagent transcript in the expanded tool card

## Overview

A `subagent` tool card keeps the delegated conversation in its expanded body. The nested transcript is rendered with the same rows, bubbles, role labels and colours as the main chat transcript, so a delegated run reads as a conversation instead of a separate widget.

## What the expanded card shows

| Nested turn | Rendered as |
| --- | --- |
| `system` | The collapsed **System prompt · N lines** card the main transcript uses for the active system prompt. |
| `user` | A user chat bubble, right-aligned, with the `user` role label. |
| `assistant` | An assistant chat bubble with markdown, labelled with the model that ran the delegated call. |
| `tool` | A compact nested tool row (verb label, one-line arguments, per-tool result summary, status dot, per-tool preview) — not a chat bubble, so the assistant→tool→assistant loop stays readable. |

While the run is in flight, streamed answer deltas land in a single assistant bubble under the **Subagent is working…** line; the card is re-rendered into the final transcript above once the run settles.

## Nested tool rows

A tool row inside the subagent card is rendered with the **same classes the main transcript's tool card head uses** — `.tool-card__name` for the verb label, `.tool-card__args` for the one-line arguments, `.tool-card__result-summary` for the collapsed summary and `.tool-card__pill` for the status dot. A delegated call therefore reads at the main card's type scale, casing, argument budget (220 characters) and dot size, instead of on a private style scale.

- **One row per call.** The live stream emits a `tool_call` and later its `tool_result`; the persisted nested chat stores them as two separate messages (an assistant turn carrying `tool_calls`, then a `role: "tool"` turn). Both paths render **one** row: the status dot flips from `running` to `ok` / `error` and the summary and preview fill in when the result lands.
- **Rows sit next to the bubbles.** Tool rows are appended at the same level as the chat bubbles, which is where the live container puts them, so a call keeps its position when the run settles.
- **A direct `@agent` dispatch settles into its own card.** The `@<agent> <task>` composer command opens the top-level `subagent` card before the server has answered, so it is keyed with a placeholder id; once `POST /api/tools/subagent` returns the id it actually minted, the card is re-keyed to it before the result is appended. Both sides then agree on `data-tool-id` and the one card flips from `running` to `ok` / `error` in place, instead of leaving a stranded **Subagent is working…** card beside a duplicate result card. A request that fails outright has no id to adopt, so the placeholder card is retired.
- **No empty assistant bubble.** An assistant turn that only asked for tools carries no text of its own; it renders as its tool rows, matching the main transcript, which skips empty assistant turns.
- **No chevron.** A nested row has no expand/collapse of its own — the parent subagent card owns that — so it carries no chevron and is not a tap target.

## Usage

1. Enable the **Subagent** tool for the project in Settings → Project and approve a delegation (or use an `@agent` mention in the composer).
2. Tap the `Subagent` card header to expand or collapse it. The nested chat is visible in both states.
3. Read the delegated conversation top to bottom: the subagent's prompt, the delegated task, its tool calls, and its final answer.

## Implementation notes

- `renderSubagentChat()` in [frontend/src/components/chat/transcript.js](../../frontend/src/components/chat/transcript.js) builds each nested turn. It shares `buildSystemPromptRow()` and the `.chat-msg__head` / `.chat-msg__role` / `.chat-msg__ts` shape with `appendMessageToTranscript()`, so the two transcripts cannot drift apart.
- Nested turns carry no timestamp and no `modelId`, so the timestamp element is rendered hidden and the assistant label uses the delegated run's model id from the tool result (`result.model.id`), falling back to `assistant`.
- The system turn's `content` is an array of typed content parts in provider shape, not a string. `textOfContent()` flattens it (`text` parts joined by a blank line) and pretty-prints unknown shapes instead of dumping the parts as JSON.
- `tool-card__subagent-msg` only drops the entry animation. The nested rows deliberately keep `.chat-msg`'s own width cap, bubble geometry and colours from [frontend/src/chat-transcript.css](../../frontend/src/chat-transcript.css); `tool-card__subagent-chat` restores the transcript's type scale and foreground colour inside the card body.
- Nested tool rows are built by `buildSubagentToolRow()` and settled by `fillSubagentToolRow()`, both shared by the live stream (`handleSubagentStreamEvent()`) and the final render (`appendSubagentNestedToolCall()` / `appendSubagentToolResult()`). Because one function owns each step, the streamed and settled rows cannot disagree; `renderSubagentChat()` keys the rows it created by call id so the matching `role: "tool"` message fills that row instead of appending a second one.
- The argument budget is the shared `TOOL_ARGS_PREVIEW_CHARS` constant (220), used by `buildToolCardHead()` and `buildSubagentToolRow()` alike — an argument is never truncated at one length in the main transcript and another length inside the card.
- `.tool-card__subagent-tool` itself owns only the flex layout (`flex-wrap: wrap` keeps the per-tool preview on its own line inside the row) and the row's label, arguments, summary and dot get their styling from the main card's classes in [frontend/src/tool-cards.css](../../frontend/src/tool-cards.css). The old `.tool-card__subagent-tool-name` / `.tool-card__subagent-text` rules and the 6 px dot override were removed with the private scale they described.
- The subagent body rule is written as `.tool-card.tool-card--subagent .tool-card__body` so it out-specifies the generic `.tool-card.is-expanded .tool-card__body` rule in [frontend/src/tool-cards.css](../../frontend/src/tool-cards.css). Without the extra `.tool-card` qualifier the panel was silently dropped the moment the card expanded, and subagent content was restyled to the flat, indented tool-output layout.
- `scripts/test-subagent-transcript-parity.js` loads the module with a DOM stub and asserts the row shape, the delegated model label, the system card, the live streaming bubble, and — for one call rendered through both paths — that the live and settled nested rows are field-for-field identical (label, arguments, status dot, result summary) and that a call plus its result produce exactly one row. It fails on the pre-parity renderer.

## Related

- [Agents](agents.md)
- [Chat UI](chat-ui.md)
- [Live tool preview](live-tool-preview.md)
- [Tool popup](tool-popup.md)
