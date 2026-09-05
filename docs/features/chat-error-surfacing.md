# Chat error surfacing

## Overview

AI requests can fail in the middle of a turn: the provider returns an HTTP error, the network drops, or a tool round crashes. Before this feature, a mid-turn failure was emitted only when *no* content had been produced yet, and it appeared only in the composer's transient status line — the chat itself showed a permanently stuck "streaming…" state with no explanation. Now every failure is emitted over SSE, rendered as an inline error bubble in the transcript, and persisted as a `system` message so it survives a reload.

## Usage

No configuration. When a turn fails you see a red-tinted bubble at the failure point in the conversation:

- The bubble carries the error code and message (e.g. `EUPSTREAM: Upstream 429 Too Many Requests — rate limit exceeded`).
- If the model produced partial output before failing, that partial output is persisted first as an assistant message, then the error bubble follows it — the transcript shows exactly what was produced before the failure.
- Reloading the chat re-renders the error bubble from the persisted transcript; the post-stream reconciliation never erases it.
- Client-side send failures (network down before the request reached the server, HTTP 4xx rejections such as `409 EALREADY_RUNNING`) render the same bubble locally.
- If saving the model selection or clearing the saved draft fails before sending, the composer keeps its exact text and image attachments. The status line explains that the message was not sent, and Send becomes available for another attempt.

## Implementation notes

Send preparation is guarded separately from the streaming request. Both network exceptions and rejected persistence responses reset the running state without adding an optimistic transcript row. The textarea and attachment picker are cleared only after preparation succeeds.
