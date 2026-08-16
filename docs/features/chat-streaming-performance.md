# Chat streaming performance

## Overview

The chat transcript renders assistant text **incrementally** while an SSE turn is streaming. Each token delta is appended as a single text node instead of rebuilding the whole assistant bubble from the full accumulated string. This removes the O(n²) re-encode and per-token DOM teardown/recreate that made long turns burn CPU and memory.

## Usage

No user-visible controls — the behavior is automatic. Open a chat and watch a long response stream: the text appears progressively with the same look as before, but the page stays responsive.

## Related

- [Chat UI](./chat-ui.md) — the Preact + Vite shell that hosts the transcript.
- [Usage metrics](./usage-metrics.md) — the live token-speed meta line repaints on a separate 120 ms throttle, independent of this path.
