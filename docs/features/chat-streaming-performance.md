# Chat streaming performance

## Overview

The chat transcript renders assistant text **incrementally** while an SSE turn is streaming. Each token delta is appended as a single text node instead of rebuilding the whole assistant bubble from the full accumulated string. This removes the O(n²) re-encode and per-token DOM teardown/recreate that made long turns burn CPU and memory.

## Usage

No user-visible controls — the behavior is automatic. Open a chat and watch a long response stream: the text appears progressively with the same look as before, but the page stays responsive.

## Implementation notes

Token appends, transcript mutations, and resize notifications share one per-transcript animation-frame scheduler. A burst of deltas performs no synchronous scroll-height reads; each scheduled frame reads geometry once before writing the bottom position. Follow-up frames stop after the layout settles, while late image/tool growth can schedule another pass.

The scroll listener remains the source of truth for whether the reader is pinned. Scrolling up cancels following, Jump to latest re-enables it, and pagination/render suspension takes precedence. Pending frames are cancelled on cleanup. Resize observers track only direct message rows; nested text mutations no longer scan every row to rebuild that set.

## Related

- [Chat UI](./chat-ui.md) — the Preact + Vite shell that hosts the transcript.
- [Usage metrics](./usage-metrics.md) — the live token-speed meta line repaints on a separate 120 ms throttle, independent of this path.
