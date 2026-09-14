# Chat loading state

## Overview

Opening a chat fetches several things at once — the chat record, the newest page of the transcript, the prompts, tools, MCP servers, agents, and actions. Until that batch answers there is no row to render, so the conversation area used to sit blank with no sign that anything was happening. This page documents the loading placeholder that fills that gap and the two failure sentences that replace it.

## Usage

No controls and nothing to configure — the behavior is automatic.

- Open any chat. The transcript shows a centred ring and the sentence **Loading conversation…** while the load batch is in flight.
- The placeholder disappears the moment the transcript paints. On a fast local connection it may be visible for only a frame, which is correct: it is a state, not a delay.
- If the chat record cannot be found (`404`), the transcript shows **This chat could not be found. It may have been deleted.** and the header stays on the previous chat's title.
- If the batch fails (a dropped connection, a server error), the transcript shows **Could not load this chat. Check the connection and reopen it.** and the composer's status line reads `load failed`.

Switching chats mid-load clears the placeholder rather than leaving it standing in the chat you moved to.

## Implementation notes

The transcript is imperative DOM — every row is written by `frontend/src/components/chat/transcript.js`, not by Preact — so the placeholder is a DOM row of the same kind, not a React value. It is mounted by the chat load effect in `frontend/src/components/chat/useChatState.js` *before* its first `await`, and removed by the rebuild that follows:

```js
async function load() {
  if (!projectDir || !chatId) return;
  if (!cancelled) showTranscriptLoading(refs);
  try {
    const [rChat, rModels, rProviders, rMsgs, ...] = await Promise.all([...]);
    // ...
    renderTranscriptBound();   // rebuild replaces the placeholder
  } catch (err) {
    if (!cancelled) showTranscriptLoadError(refs, 'Could not load this chat. …');
  }
}
```

Three helpers own the state:

| Helper | Effect |
| --- | --- |
| `showTranscriptLoading(refs, label?)` | Clears the transcript and mounts the ring + sentence. Safe to call twice; the second call replaces the first. |
| `clearTranscriptLoading(refs)` | Removes any placeholder without touching message rows. |
| `showTranscriptLoadError(refs, message)` | Mounts the same row without the ring, for a load that will not resolve. |

The rebuild does not need to call `clearTranscriptLoading` explicitly: `clearTranscriptRows` already drops every non-overlay child, and the placeholder is an ordinary child. `clearTranscriptLoading` exists for the two paths that do not rebuild — the per-chat cleanup effect (a superseded load), and any future caller that needs to cancel a load without a chat change.

Two related guards keep the placeholder from being misread as content:

- `findTranscriptContentStart` skips `.chat-view__loading` alongside `.chat-view__setup` and `.chat-view__empty`, so backward pagination never inserts older history above the placeholder.
- `mountOverlayCard` (in `frontend/src/components/chat/overlay.js`) treats a transcript holding only a placeholder as empty, so an authorization or `ask_user` card is deferred to the pending-auth poll instead of being wiped by the rebuild that is about to land.

Styling lives in `frontend/src/chat-transcript.css`. The ring is drawn from `currentColor` with an accent top arc, matching the dictation spinner, so no new colour is introduced and the reduced-motion fallback still reads as *working* rather than as an empty box. The row is centred, spans the transcript's shared measure, and has a `min-height` so it occupies the conversation area rather than collapsing to a thin line.

## Regression checks

```bash
node scripts/test-transcript-loading-placeholder.js
```

Covers mounting, the double-start replace, the rebuild clear, the error state, and the inert no-transcript case. It also runs as part of `npm test`.

## Related

- [Chat UI](./chat-ui.md) — the transcript shell this state renders into.
- [Chat load performance](./chat-load-performance.md) — what the load batch contains and how it is kept fast.
- [Chat error surfacing](./chat-error-surfacing.md) — errors that belong to a turn, as opposed to a load.
