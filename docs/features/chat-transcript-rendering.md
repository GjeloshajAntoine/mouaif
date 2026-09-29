# Chat transcript rendering

## Overview

The chat transcript reuses the DOM rows that are already on screen instead of destroying and rebuilding them on every render pass. A row whose identity has not changed keeps its element; a header card whose inputs have not changed keeps its node. A pass over unchanged data therefore performs no DOM mutation at all, which is what stops the transcript from flashing.

## Usage

No user-visible controls — the behavior is automatic. Open a chat, send a message, or leave an idle chat on screen: rows appear and update in place, and the conversation area no longer blinks between paints.

## Behavior

- **Rows are reused, not rebuilt** — a row keeps its element while its identity is unchanged, so nothing replays the entry animation. The cheap tail-append path applies the same rule: a row already mounted under its key (a live bubble the follower stamped with the persisted row's `seq`) is skipped rather than drawn a second time.
- **Returning to a running chat fills in place** — when a run advances while you are in another app, the rows that arrived while you were away (a tool call and its result, which have no optimistic twin, plus the new answer) are placed by key beside the rows already on screen. The transcript is not re-parsed or rebuilt, so coming back to the chat no longer re-renders and re-animates the whole conversation on the first frame.
- **Rows stay in conversation order** — a row the reconciler has to build, such as a tool call and its result that arrive after the answer that follows them is already on screen, is placed at its position in the conversation rather than left at the bottom. Tool cards are matched by tool id, so a card the live stream drew is kept and moved into place, and parallel calls keep their call order.
- **Tool-card lookups are indexed** — resolving a card by tool id and recovering a result row's call arguments are constant-time, rather than a DOM walk and a transcript scan per row. This is what keeps a redraw of a tool-heavy chat proportional to the number of rows instead of to its square.
- **Off-screen rows are skipped** — a long transcript's rows that are nowhere near the viewport are not laid out or painted, with a placeholder height so the scrollbar does not jump.
- **The Thinking block keeps your choice** — a reply's reasoning block is open while it streams and folds shut when the reply finishes. Once you tap its summary, your choice wins over both defaults: a block you re-opened to keep reading stays open when the reply is finalized, and one you closed stays closed through the rest of the stream. The choice is kept on the message body, which is the same element across the streaming and final renders (`scripts/test-reasoning-user-toggle.js`).

## Related

- [Chat UI](./chat-ui.md) — the Preact + Vite shell that hosts the transcript.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
- [Chat load performance](./chat-load-performance.md) — latest-first rendering and the incremental tail sync.
- [Chat backward pagination](./chat-backward-pagination.md) — windowed loading of long transcripts.

