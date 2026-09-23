# Chat streaming performance

## Overview

The chat transcript renders streamed text **incrementally** while an SSE turn is streaming. Each delta is appended as a single text node instead of rebuilding the whole element from the full accumulated string. This removes the O(n²) re-encode and per-delta DOM teardown/recreate that made long turns burn CPU and memory.

The same treatment applies to the live previews that stream *beside* the reply: a shell command's output and a delegated subagent's nested answer.

## Usage

No user-visible controls — the behavior is automatic. Open a chat and watch a long response stream, run a long build through the shell tool, or delegate to a subagent: the text appears progressively with the same look as before, but the page stays responsive.

## Behavior

- **Assistant reply** — token deltas append to the answer element in the live bubble.
- **Shell output** — chunks append to the card's live preview. The preview is capped (120 KiB); past the cap the tail is replaced by a one-time truncation notice, and the full output still arrives with the tool result, which replaces the preview entirely.
- **Subagent reply** — nested deltas append to the delegated bubble, and nested shell output appends the same way.
- **Preview scrolling** — the live preview is pinned to its bottom at most once per animation frame, so a burst of chunks costs one layout instead of two per chunk. A command that streams output faster than the frame rate no longer stalls the page.

## Related

- [Chat UI](./chat-ui.md) — the Preact + Vite shell that hosts the transcript.
- [Usage metrics](./usage-metrics.md) — the live token-speed meta line repaints on a separate 120 ms throttle, independent of this path.
- [Live tool preview](./live-tool-preview.md) — the follower stream that replays this content into a returning page.


