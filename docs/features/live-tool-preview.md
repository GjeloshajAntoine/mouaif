# Live tool preview on returning to a running chat

## Overview

When a chat is running, live output from long-running tools (such as terminal commands, nested subagent activity, progress indicators, and approval prompts) is streamed in real time to any client. If you navigate away and return or view the chat on another device, active tool runs display their live activity instead of a static waiting state.

## Behavior

- **Live multi-client preview** — open a running chat on another tab or device to view the active tool output as it happens.
- **Fast reconnection** — returning to an active turn displays the live tool card immediately.
- **Seamless completion** — when execution completes, the tool card transitions to its finalized result state.

## Related

- [Chat UI](chat-ui.md)
- [Chat streaming performance](chat-streaming-performance.md)
- [Chat load performance](chat-load-performance.md)
- [Run settle latch](run-settle-latch.md)
- [Progress tool](progress-tool.md)
