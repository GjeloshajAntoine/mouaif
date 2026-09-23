# Subagent transcript in the expanded tool card

## Overview

A `subagent` tool card keeps the delegated conversation in its expanded body. The nested transcript is rendered with the same rows, bubbles, role labels and colours as the main chat transcript, so a delegated run reads as a conversation instead of a separate widget.

## What the expanded card shows

| Nested turn | Rendered as |
| --- | --- |
| `system` | The collapsed **System prompt · N lines** card the main transcript uses for the active system prompt. Its role label names the agent the run dispatched (`Search`), or `agent` for a generic delegation. |
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

## Naming the agent

A delegated run names the agent it dispatched, in two places:

- a `.tool-card__agent` chip in the card head, beside the generic `Subagent` label;
- the role label of the nested system row.

The name comes from the `subagent` call's `agent` argument, which the server echoes back on the result as `result.agent`. It has to ride the result payload: the nested transcript does not contain it (an agent's system message is its instructions, not its name), so without it a `@reviewer` dispatch and a model-driven generic delegation render identically. A run with no `agent` argument shows no chip and labels its system row `agent`.

## Usage

1. Enable the **Subagent** tool for the project in Settings → Project and approve a delegation (or use an `@agent` mention in the composer).
2. Read the delegated conversation directly under the card head — a settled `Subagent` card opens itself (`is-expanded`), because the nested transcript IS its body. Tap the header to collapse or re-expand it; `is-expanded` is authoritative, so a collapsed card really hides its transcript.
3. Read the delegated conversation top to bottom: the subagent's prompt, the delegated task, its tool calls, and its final answer.
4. To see which agent ran, read the chip in the head or the nested system row's role label.

## Expand and collapse

- **A settled card opens itself.** `appendToolResultCard` leaves a successful `subagent` card `is-expanded` (unless the user collapsed it), because the nested transcript IS its body — a collapsed card would render as a bare `Subagent · task · ok` header with the conversation hidden behind an undiscoverable tap.
- **A running card opens itself too.** The live body is created while the run is in flight so nested activity streams into a card the user can already see.
- **Collapsing works.** `is-expanded` is the single source of truth for a subagent card's body visibility, exactly as for every other card. Tapping the header collapses the card and hides the transcript; tapping again re-expands it.
- **The user's collapse wins over auto-expand.** The header tap records `card._userCollapsed`, and both the settle path and the rebuild path honor it, so a card the user closed does not pop back open when its result lands or when the transcript reconciles.

## Related

- [Agents](agents.md)
- [At-mention](at-mention.md)
- [Chat UI](chat-ui.md)
- [Live tool preview](live-tool-preview.md)
- [Tool popup](tool-popup.md)
