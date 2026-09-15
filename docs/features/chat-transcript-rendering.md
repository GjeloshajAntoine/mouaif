# Chat transcript rendering

## Overview

The chat transcript reuses the DOM rows that are already on screen instead of destroying and rebuilding them on every render pass. A row whose identity has not changed keeps its element; a header card whose inputs have not changed keeps its node. A pass over unchanged data therefore performs no DOM mutation at all, which is what stops the transcript from flashing.

## Usage

No user-visible controls — the behavior is automatic. Open a chat, send a message, or leave an idle chat on screen: rows appear and update in place, and the conversation area no longer blinks between paints.

## Implementation notes

A re-created element replays its CSS entry animation, and `.chat-msg` animates from `opacity: 0` (see `frontend/src/chat-transcript.css`). The transcript used to be rebuilt by removing every child and drawing it again from `state.messages`, so each pass restarted that animation even when nothing had changed — on an empty chat the system-prompt row was torn down and rebuilt on every reconcile tick. Reconciliation fixes the cause instead of suppressing the animation: an unchanged row is reused, so there is nothing left to animate.

Each message row carries a stable key, computed by `transcriptRowKey(m)` in `frontend/src/components/chat/transcript.js`:

| Row | Key |
| --- | --- |
| Persisted row | `seq:<n>` — the message store is append-only, so a given seq never changes |
| Tool call / result | `tool:<toolCallId>:<phase>` — a call and its result are two messages but two distinct rows |
| Optimistic or live row | object identity from a `WeakMap`, which survives a merge because untouched rows keep their reference |

`reconcileTranscriptRows(state, refs, order)` walks the renderable messages in display order while holding a cursor at the position the next row must occupy. A reused row already sitting at the cursor is left untouched; a row that is missing is built, and its new node is found by diffing the child list around the builder call, because the builders insert themselves. Only rows whose key has left the transcript are removed. Duplicate keys — the leftover of an overlapping pass — collapse to the first node.

Header cards are gated the same way. `headerSignatures(state, empty)` reduces the inputs of the four cards above the messages (system prompt, tools, agent files, skills) plus the setup control to a signature string each, and `syncHeaderCards` rebuilds a card only when its signature moved or its node is missing. The empty-state block is kept as a node rather than rebuilt while the chat stays empty.

Other rules the pass preserves:

- Authorization and `ask_user` overlay cards are not message rows. They are mounted beside the transcript while a run is parked, they carry `data-auth-call-id`, and the reconciler never matches, moves, or removes them.
- A pass for a different chat must not reconcile against the rows of the chat the user just left, since equal seqs would key onto the wrong nodes. `chatTranscriptKey(state)` (project dir + chat id) detects the switch and resets the row block, the card signatures, and the per-chat group-expansion memory.
- A long transcript still renders progressively, because a first paint that blocks on a full markdown build is worse than an animation. The chunked pass runs only when no message rows are mounted yet; rows already on screen are reused and only the not-yet-reached rows are created.
- An empty chat creates no rows, so an idle pass leaves the scroll position alone instead of re-pinning it.

The file-order tests drive this module in a `vm` context with a minimal element stub, so the reconciler reads `className` as a string rather than through `classList`, and those harnesses must expose `WeakMap` alongside the other globals they provide.

## Related

- [Chat UI](./chat-ui.md) — the Preact + Vite shell that hosts the transcript.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
- [Chat load performance](./chat-load-performance.md) — latest-first rendering and the incremental tail sync.
- [Chat backward pagination](./chat-backward-pagination.md) — windowed loading of long transcripts.
