# Message copy

## Overview

Every user and assistant bubble in a chat carries a small **Copy** button below it. One tap puts that message's text on the clipboard, so a user can paste an answer into a ticket, a commit message, or another tool without selecting text by hand on a touch screen. The button gives its feedback in place, so nothing covers the conversation.

## Usage

1. Open a chat.
2. Under any of your own messages or any assistant answer, tap **Copy**.
3. The label changes to **Copied** for about 1.4 s, then returns to **Copy**. If the clipboard refuses the write the label reads **Copy failed** instead.

What gets copied:

- **User turns** — the message text exactly as it was sent.
- **Assistant turns** — the final answer. A `Thinking` block is scaffolding, not the reply, so it is left out when the turn also has an answer. A turn that was stopped before its first content token has no answer, so it copies its reasoning rather than an empty string.
- **Image attachments** — an attached image lives in the DOM as a `data:` URL and cannot travel through the clipboard as text, so the message lists the attachment by file name instead, e.g.:

```text
look at this

[image: shot.png]
```

Not copied, by design:

- **Tool cards** — tool calls and results are already reachable through the file viewer and the tool card's own actions.
- **Error bubbles** — an error card keeps its **Retry** action; see [Chat error surfacing](./chat-error-surfacing.md) and [Retry and auto-retry](./retry-and-auto-retry.md).
- **System prompt / setup cards** — collapsed reference material rather than a turn.

The button is available while a turn is still streaming: tapping it copies the text that is on screen at that moment.

## Implementation notes

- **Where the button is built** — `buildCopyButton()` in [frontend/src/components/chat/transcript.js](frontend/src/components/chat/transcript.js) returns the element; `appendMessageToTranscript()` mounts it in a `.chat-msg__actions` block appended after the bubble body for `user` and `assistant` rows only. Appending rather than floating keeps it off the text on a 360 px screen and matches the shape of the error card's action row.
- **Live turns** — a streaming assistant row writes into the row itself (`row._content`, `row._reasoning`), not into the placeholder message it was created from, so the button resolves its payload at click time through a closure rather than capturing a snapshot. A settled row simply returns its message object.
- **What a message copies** — `messageCopyText()` in [frontend/src/components/chat/utils.js](frontend/src/components/chat/utils.js) is the single place that decides this, so the button and any future copy entry point cannot disagree.
- **Clipboard access** — the same module exports `copyText()`, which tries `navigator.clipboard.writeText()` and falls back to a hidden `textarea` + `document.execCommand('copy')` for embedded web views and non-secure origins. It returns a boolean rather than throwing, so the button can report a refusal in place. The helper mirrors the ones already used by `chat/GitModal.jsx` and `Inspector.jsx`.
- **Styling** — `.chat-msg__actions` / `.chat-msg__copy` (with the `is-copied` / `is-failed` states) live in [frontend/src/chat-transcript.css](frontend/src/chat-transcript.css). The button uses the shared `.btn` sizing and inherits the row's alignment, so it sits under the right edge of a user bubble and the left edge of an assistant bubble.
- **Covered by** `scripts/test-message-copy.js` (wired into `npm run test:chat-view`): it asserts what each message shape copies and that user/assistant rows mount the button while error cards mount only Retry.
