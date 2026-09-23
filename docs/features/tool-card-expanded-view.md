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
| `list_files`, `search_files` | Results under one path label per directory, nested by depth |
| `subagent` | The nested conversation as chat rows |

Behavior notes:

- **Successful cards stay collapsed.** Expanding is always the user's choice.
- **Failed cards auto-expand**, so the error is visible without a tap.
- **A long command is shown above its output**, not buried under it, so the card reads "what ran, then what came back".
- **An expanded shell card always shows its command.** The block is not conditional on the collapsed head having been truncated. The head clips its text twice — at `TOOL_ARGS_PREVIEW_CHARS` in JS, and at the row width in CSS (`flex: 1 1 auto` + `overflow: hidden` + `text-overflow: ellipsis`) — and on a 390 px screen the CSS clip lands around 30-50 characters. A 50-character command is therefore under the text cap yet still rendered as `cd /home/ubuntu/mouaif && git diff --ca…`, with the rest shown nowhere. In the reference chat all 92 shell heads were visually clipped, so every one of them was hiding part of its command.
- **The arguments block scrolls** rather than growing without bound: it is capped at one third of the viewport height, so one enormous command cannot push the tool's output off screen.
- **A shell card is one terminal.** The command is not a separate surface: no second colour, and no divider line between the command and its output. The two sections are separated by space alone.
- **That terminal is one visible box.** The background, border, radius and padding live on the card body element itself, not on either section; the command and the output are both transparent inside it, so the card reads as a single bounded terminal against the page rather than as unboxed text. Without this the body was invisible on a dark theme, because its colour (`--bg`) is the same as the page behind it. The surface cannot live on a child: which child carried it would depend on render order, and on the error path the status line is drawn *between* the command and the output, so a child border would split one card into two.
- **Long output scrolls inside the card**, capped at 40% of the viewport height.
- **Result bodies build on first expand.** The structured preview is created the first time a card opens and is cached on the element, so a tool-heavy transcript does not pay for DOM it never shows.

## Related

- [Chat UI](./chat-ui.md)
- [Chat transcript rendering](./chat-transcript-rendering.md) — rows are reused rather than rebuilt, so an expanded card survives a reconcile pass.
- [Chat streaming performance](./chat-streaming-performance.md)
- [Live tool preview](./live-tool-preview.md) — output streamed while a tool is still running.
- [Shell tool](./shell-tool.md)
- [Native file tools](./file-tools.md)
