# Subagent transcript in the expanded tool card

## Overview

A `subagent` tool card keeps the delegated conversation in its expanded body. The nested transcript is rendered with the same rows, bubbles, role labels and colours as the main chat transcript, so a delegated run reads as a conversation instead of a separate widget.

## What the expanded card shows

| Nested turn | Rendered as |
| --- | --- |
| `system` | The collapsed **System prompt · N lines** card the main transcript uses for the active system prompt. |
| `user` | A user chat bubble, right-aligned, with the `user` role label. |
| `assistant` | An assistant chat bubble with markdown, labelled with the model that ran the delegated call. |
| `tool` | A compact nested tool row (verb label, one-line arguments, status dot, per-tool preview) — not a chat bubble, so the assistant→tool→assistant loop stays readable. |

While the run is in flight, streamed answer deltas land in a single assistant bubble under the **Subagent is working…** line; the card is re-rendered into the final transcript above once the run settles.

## Usage

1. Enable the **Subagent** tool for the project in Settings → Project and approve a delegation (or use an `@agent` mention in the composer).
2. Tap the `Subagent` card header to expand or collapse it. The nested chat is visible in both states.
3. Read the delegated conversation top to bottom: the subagent's prompt, the delegated task, its tool calls, and its final answer.

## Implementation notes

- `renderSubagentChat()` in [frontend/src/components/chat/transcript.js](../../frontend/src/components/chat/transcript.js) builds each nested turn. It shares `buildSystemPromptRow()` and the `.chat-msg__head` / `.chat-msg__role` / `.chat-msg__ts` shape with `appendMessageToTranscript()`, so the two transcripts cannot drift apart.
- Nested turns carry no timestamp and no `modelId`, so the timestamp element is rendered hidden and the assistant label uses the delegated run's model id from the tool result (`result.model.id`), falling back to `assistant`.
- The system turn's `content` is an array of typed content parts in provider shape, not a string. `textOfContent()` flattens it (`text` parts joined by a blank line) and pretty-prints unknown shapes instead of dumping the parts as JSON.
- `tool-card__subagent-msg` only drops the entry animation. The nested rows deliberately keep `.chat-msg`'s own width cap, bubble geometry and colours from [frontend/src/chat-transcript.css](../../frontend/src/chat-transcript.css); `tool-card__subagent-chat` restores the transcript's type scale and foreground colour inside the card body.
- The subagent body rule is written as `.tool-card.tool-card--subagent .tool-card__body` so it out-specifies the generic `.tool-card.is-expanded .tool-card__body` rule in [frontend/src/tool-cards.css](../../frontend/src/tool-cards.css). Without the extra `.tool-card` qualifier the panel was silently dropped the moment the card expanded, and subagent content was restyled to the flat, indented tool-output layout.
- `scripts/test-subagent-transcript-parity.js` loads the module with a DOM stub and asserts the row shape, the delegated model label, the system card, and the live streaming bubble. It fails on the pre-parity renderer.

## Related

- [Agents](agents.md)
- [Chat UI](chat-ui.md)
- [Live tool preview](live-tool-preview.md)
- [Tool popup](tool-popup.md)
