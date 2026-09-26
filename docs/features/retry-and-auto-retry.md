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

- The setting lives in **Settings → App defaults → Chat defaults**, where it
  defaults to on.
- When a turn fails before any response starts, the client immediately
  resends it once and shows an `auto-retrying…` status. Retried sends
  are themselves never auto-retried again, so a persistently failing
  message cannot loop.
- A chat created before the setting was turned off keeps its own recorded
  choice; new chats follow the app default.
