# Tool card expanded view

## Overview

Every tool call the model makes renders as a compact card in the transcript: one line with the verb (`Ran`, `Read`, `Edited`, …), the call arguments, a result summary, and a status dot. Tapping the row expands the card to show what came back. The expanded card is also the only place a long call is readable in full — the collapsed row is a single ellipsized line, so a commit-message heredoc or a compound `&&` command is restored there in its entirety.

## Usage

Tap a tool card's header row to expand or collapse it.

| Tool | Expanded card shows |
| --- | --- |
| `shell` | The full command, then the exit meta line, then stdout and stderr |
| `read_file` | The resolved path, then the file body |
| `write_file` | The written content, capped at 2000 lines / 200 000 chars |
| `edit_file` | A line-by-line diff with add/remove gutters |
| `list_files`, `search_files` | Results under one path label per directory, nested by depth — the search's scope, its query, then wrapped match rows |
| `subagent` | The nested conversation as chat rows |
| Any other tool (MCP, custom action) | The call's arguments, then the result |
| `webpreview` | The captured URL and mode, then the status line |

Behavior notes:

- **Every type shows the call, not just the result.** An expanded card reads *what ran, then what came back*, for every tool — a command, a path, a search scope, an MCP argument object. Before this, only `shell` rendered its call arguments, so an MCP card showed only the response and a `search_files` card never showed the directory it searched. A call with no arguments adds no block (an empty `{}` does not render an empty "Arguments" heading).
- **The collapsed head reads the same from either row.** A card is built either from its call row (the live stream) or from its result row alone (the tail-first chunked render, a pagination page, a reconcile). Both now show the call's one-line arguments; before, the result-first card lost them for every type but shell/subagent, so the same call read `Read | ok` or `Read | src/a.js lines 1-50 | ok` depending on which row the render reached first.
- **A listed path or a matched line wraps, never clips.** These rows used `text-overflow: ellipsis`; the expanded card is the only place a result is readable, so a clipped row meant the content was nowhere.
- **Successful cards stay collapsed.** Expanding is always the user's choice.
- **Failed cards auto-expand**, so the error is visible without a tap.
- **One scroller per card.** The card body is the only part of an expanded card that scrolls vertically. The arguments block and the live or final output grow inside it and scroll with it, so on a touch screen a swipe never gets caught by a smaller box nested inside the card. A very long command pushes the output further down, but both stay inside the body's height cap (`scripts/test-tool-card-single-scroller.js`).
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
