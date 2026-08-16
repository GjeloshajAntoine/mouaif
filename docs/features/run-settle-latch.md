# Run settle latch

## Overview

Prevents status flickering when reopening or returning to a conversation that recently completed in another tab or after a brief network interruption.

## Behavior

- **Stable status display** — completed runs stay marked as finished and do not oscillate between busy and idle.
- **Accurate activity indicators** — the stop button and active progress states appear only when a turn is genuinely generating output.

## Related

- [Chat UI](chat-ui.md)
- [Chat streaming performance](chat-streaming-performance.md)
