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

### The header block has one fixed order

The header block is laid out as

```text
[setup] [system prompt] [tools] [agent files] [skills] [empty state]
```

always above the message rows and any standing overlay card. That order used to be an accident of mount timing, because each card mounter located its own slot by looking up a sibling anchor — "insert after the system-prompt row, else before the empty state, else `appendChild()`". Every one of those anchors can legitimately be absent (the system-prompt row is removed and re-inserted on every prompt refresh; the empty-state block leaves with the first message), and the `appendChild()` fallback dropped the card **below the conversation** — the prompt and tool toggles appearing in the middle of the transcript.

`frontend/src/components/chat/headerCards.js` owns the block's order:

| Export | Purpose |
| --- | --- |
| `headerCardIndex(el)` | Slot of a mounted header card, or `-1` for a message row, tool card, overlay card, or padding |
| `isHeaderCardNode(el)` | `headerCardIndex(el) !== -1` — used by the transcript to classify nodes |
| `placeHeaderCard(el, card, index)` | Put a card in its slot in one mutation: before the first child that is not a header card, or is a header card from a later slot |
| `orderHeaderCards(refs)` | Invariant pass that re-slots every mounted header card |

`placeHeaderCard` computes its reference node from slot indices rather than from an anchor lookup, so **no anchor is required**: with every other card absent it still inserts above the message rows. A card already sitting in its slot is not moved — moving a node replays its CSS entry animation, so a settled pass must perform no mutation. `orderHeaderCards` runs at the end of `syncHeaderCards`, which makes the final order independent of which mounters ran.

The system-prompt row is the one header card that is also a `.chat-msg` bubble. `isMessageRowNode` excludes it via `isHeaderCardNode`, because otherwise the reconciler treated it as an unkeyed message row: it parked its row cursor on it and inserted the real messages **above** the header block, and it culled the row on the next pass whenever the row was no longer the first child. `findTranscriptContentStart` uses the same classification, so the pagination prepend and the mounters cannot drift apart.

`scripts/test-transcript-header-order.js` pins all of it — slot placement with every anchor absent, the no-op settled pass, the repair of a mis-ordered block, and the reconciler keeping messages below the header block.

Other rules the pass preserves:

- Authorization and `ask_user` overlay cards are not message rows. They are mounted beside the transcript while a run is parked, they carry `data-auth-call-id`, and the reconciler never matches, moves, or removes them.
- A pass for a different chat must not reconcile against the rows of the chat the user just left, since equal seqs would key onto the wrong nodes. `chatTranscriptKey(state)` (project dir + chat id) detects the switch and resets the row block, the card signatures, and the per-chat group-expansion memory.
- A long transcript still renders progressively, because a first paint that blocks on a full markdown build is worse than an animation. The chunked pass runs only when no message rows are mounted yet; rows already on screen are reused and only the not-yet-reached rows are created.
- An empty chat creates no rows, so an idle pass leaves the scroll position alone instead of re-pinning it.

### Tail sync picks the right DOM path

The 1 s reconcile poll and the dropped-stream recovery both fold the server's newest rows into `state.messages` with `mergeServerRows` and then update the DOM. The cheap path, `syncTranscriptAppend(state, refs, prevLen)`, renders only `messages[prevLen…]` and appends it — correct only for a **pure append**, where every prior row is still at its old index by reference. But `mergeServerRows` also replaces a seq-less optimistic twin (the just-sent user bubble, the live assistant segment) in place and splices a late-arriving persisted row into the middle of the array. Both move the prefix, so appending the tail repaints a row already on screen (a visible duplicate), drops a mid-inserted row at the bottom (wrong order), and the next poll's full rebuild then corrects it as a visible reload/flash.

`applyTailSync` (in `stream.js`) now asks `tailSyncDomAction(prev, merged)` (in `msgMerge.js`) which path to take: `'append'` for a genuine append, `'render'` for a moved prefix — which routes to the full `reconcileTranscriptRows` pass that reuses every unchanged node (so nothing re-animates) and places each row in its correct slot. `scripts/test-msg-merge.js` covers the decision.

Any test that slices `applyTailSync` out of `stream.js` and runs it in a `vm` must supply `tailSyncDomAction` alongside `mergeServerRows` and `nextServerMessageIndex`, because the slice references the helpers the module imports rather than re-declaring them. `scripts/test-chat-cost-summary.js` did not, so its tail-sync case threw before it could assert the rebased cost; it now injects the classifier and pins both branches — the reconcile render for a replaced optimistic twin, the cheap append for a genuine one.

The file-order tests drive this module in a `vm` context with a minimal element stub, so the reconciler reads `className` as a string rather than through `classList`, and those harnesses must expose `WeakMap` alongside the other globals they provide. `headerCards.js` is deliberately import-free for the same reason: a harness can load it standalone, or inject its exports into the `transcript.js` context.

## Related

- [Chat UI](./chat-ui.md) — the Preact + Vite shell that hosts the transcript.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
- [Chat load performance](./chat-load-performance.md) — latest-first rendering and the incremental tail sync.
- [Chat backward pagination](./chat-backward-pagination.md) — windowed loading of long transcripts.
