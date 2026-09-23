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
