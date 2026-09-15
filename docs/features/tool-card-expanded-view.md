# Tool card expanded view

## Overview

Every tool call the model makes renders as a compact card in the transcript: one line with the verb (`Ran`, `Read`, `Edited`, …), the call arguments, a result summary, and a status dot. Tapping the row expands the card to show what came back. The expanded card is also the only place a long call is readable in full — the collapsed row is a single ellipsized line, so a commit-message heredoc or a compound `&&` command is restored there in its entirety.

## Usage

Tap a tool card's header row to expand or collapse it.

| Tool | Expanded card shows |
| --- | --- |
| `shell` | The full command (when the head truncated it), then the exit meta line, then stdout and stderr |
| `read_file` | The resolved path, then the file body |
| `write_file` | The written content, capped at 2000 lines / 200 000 chars |
| `edit_file` | A line-by-line diff with add/remove gutters |
| `list_files`, `search_files` | Results grouped under one path label per directory or file |
| `subagent` | The nested conversation as chat rows |

Behavior notes:

- **Successful cards stay collapsed.** Expanding is always the user's choice.
- **Failed cards auto-expand**, so the error is visible without a tap.
- **A long command is shown above its output**, not buried under it, so the card reads "what ran, then what came back".
- **A short command is not repeated.** The full-arguments block is rendered only when the collapsed head had to truncate the call, so expanding an ordinary `ls -la` card looks exactly as it did before.
- **The arguments block scrolls** rather than growing without bound: it is capped at one third of the viewport height, so one enormous command cannot push the tool's output off screen.
- **A shell card is one terminal.** The command block uses the same background, border, text colour and type size as the output below it — no second colour, no second pane. Only its height differs.
- **Long output scrolls inside the card**, capped at 40% of the viewport height.
- **Result bodies build on first expand.** The structured preview is created the first time a card opens and is cached on the element, so a tool-heavy transcript does not pay for DOM it never shows.

## Implementation notes

The render path is plain DOM (no Preact), so the SSE hot path stays as cheap as a `textContent` assignment:

- `frontend/src/components/chat/toolRender.js` — one renderer per tool, dispatched by `renderToolResultBody`.
- `frontend/src/components/chat/tools.js` — `formatToolArgs` (one line, for the head) and `formatToolArgsFull` (the complete call, for the expanded card), sharing `TOOL_ARGS_PREVIEW_CHARS` = 220. Both halves of the truncation rule read the same constant, so the head can never ellipsize at one budget while the body decides to render at another.
- `frontend/src/components/chat/transcript.js` — card construction, the head's tap handler, and the lazy body. The call's arguments are stashed on the card (`card._toolArgs`) because a `tool_result` frame carries only the result; a card rebuilt from persisted data recovers them from the persisted call row.
- `frontend/src/tool-cards.css` — `.tool-preview__args` (the full-arguments block) and `.tool-preview__pre--args` (its scroll cap).

`buildToolArgs(args, name)` returns `null` when the head already showed the arguments in full. It compares against the same head format rather than a length heuristic, which is why a 20-character command adds nothing to the expanded card while a 1900-character one adds everything.

Mobile-first notes: the arguments block is a `<pre>` with `pre-wrap` so a long command wraps instead of forcing a horizontal scroll on a 360 px screen; its cap is expressed in `dvh` so it tracks the browser chrome; and the whole header row is the tap target, well over the 44 px minimum.

Colour rule: the command block must not be styled as a separate surface. `.tool-preview__pre--args` mirrors `.tool-preview__terminal` (background, border, radius, colour, font size) rather than picking its own tone, so the expanded shell card reads as one terminal instead of two panes. A muted command would also imply the command is secondary to its own output, which is backwards for a failing call.

Covered by `scripts/test-shell-card-command.js`, which pins the full command, its line breaks, its position above the output, the non-duplication of a short command, the error path, and the no-arguments case.

## Related

- [Chat UI](./chat-ui.md)
- [Chat transcript rendering](./chat-transcript-rendering.md) — rows are reused rather than rebuilt, so an expanded card survives a reconcile pass.
- [Chat streaming performance](./chat-streaming-performance.md)
- [Live tool preview](./live-tool-preview.md) — output streamed while a tool is still running.
- [Shell tool](./shell-tool.md)
- [Native file tools](./file-tools.md)
