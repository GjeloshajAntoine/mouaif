# Run settle latch

## Overview

Prevents status flickering when reopening or returning to a conversation that recently completed in another tab or after a brief network interruption.

## Usage

Return to a running or recently completed chat. The status follows the server's run state without additional controls.

## Behavior

- **Stable status display** — completed runs stay marked as finished until the server reports another run.
- **Accurate activity indicators** — the stop button and send guard stay active during generation, slow tools, and pending approvals. An unchanged transcript is not treated as completion.

## Completion state

The completion latch is cleared when a server-running revision or a new live run ID arrives. Foreground refresh also clears it before reconciling. Only a server completion (`running: false` or `run_end`) settles the run; the former two-stable-tick heuristic is no longer used.

## Related

- [Chat UI](chat-ui.md)
- [Chat streaming performance](chat-streaming-performance.md)
