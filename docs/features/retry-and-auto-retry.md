# Retry and auto-retry

## Overview

Failed turns get two recoveries. Every inline error card in a chat now
carries a **Retry** button that re-sends the failed user message. A
per-chat **auto-retry** toggle additionally re-sends a message once,
transparently, when it fails before a response starts (a network error
or an HTTP rejection other than an already-running `409`).

## Usage

### Manual retry

- Send a message that fails. The red error bubble in the transcript
  includes a **Retry** button.
- Retry re-posts the same user message the model was working on. The
  failed response stays visible above the new attempt, so nothing is
  silently discarded.

### Auto-retry

- Open a chat and tap the tools button, then toggle **Auto-retry failed
  sends** in the footer.
- The app-level default lives in **Settings → App defaults**, where it
  defaults to on. A per-chat choice overrides the app default.
- When a turn fails before any response starts, the client immediately
  resends it once and shows an `auto-retrying…` status. Retried sends
  are themselves never auto-retried again, so a persistently failing
  message cannot loop.

## Implementation notes

- `frontend/src/components/chat/stream.js` owns `retryFailedTurn` and
  `maybeAutoRetry`. Retry posts a fresh user turn (`retry: true`) so the
  failed output is preserved and no duplicate optimistic user bubble is
  drawn.
- The one-shot guard reads the retry markers **from the payload**:
  `maybeAutoRetry` returns early when `payload.retry` is set (a retry) or
  `payload.manualRetry` is set (a user tap on the error card's Retry
  button). Both failure sites therefore thread the current turn's
  `retry` / `manualRetry` flags into the payload they hand to
  `appendErrorCard`, so a retry that fails again arrives already marked
  and stops. Without that threading the guard never matched and every
  failing attempt re-armed the retry — a server that was simply down
  looped until the browser died. Regression test:
  [scripts/test-chat-auto-retry-once.js](../scripts/test-chat-auto-retry-once.js).
- `frontend/src/components/chat/transcript.js` renders the error card's
  **Retry** button via an optional `onRetry` argument to
  `appendErrorCard`. When a persisted error bubble is restored, the UI
  rebuilds the retry payload from the preceding user turn, so retry stays
  available after navigating away from the chat or reloading the app.
- The setting is persisted as a `chat_store.auto_retry` column
  (`src/chatdb.js`) and read as `chat.autoRetry` in
  `frontend/src/components/chat/useChatState.js`, falling back to the
  app-level `autoRetry` default from `src/settings.js`.