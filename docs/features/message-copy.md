# Message copy

## Overview

Every user and assistant bubble in a chat carries a small **copy icon** below it. One tap puts that message's text on the clipboard, so a user can paste an answer into a ticket, a commit message, or another tool without selecting text by hand on a touch screen. The button gives its feedback in place — the glyph itself changes — so nothing covers the conversation.

## Usage

1. Open a chat.
2. Under any of your own messages or any assistant answer, tap the **clipboard icon**.
3. The glyph becomes a **check** for about 1.4 s, then returns to the clipboard. If the clipboard refuses the write it becomes a **cross** instead.

The control is icon-only — it repeats under every bubble, so a text label would compete with the message for the same line at 360 px. The state is still announced to assistive tech through the button's accessible name: `Copy message` → `Copied message` / `Copy failed`.

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
- **The three glyphs** — `COPY_GLYPH_IDLE` / `COPY_GLYPH_COPIED` / `COPY_GLYPH_FAILED` in the same file are inline SVG drawn with `fill="none"` and `stroke="currentColor"`, so the CSS tint (`--muted` → `--success` / `--danger`) is the only color decision and the glyph follows the button's state classes. The state also travels on `aria-label` / `title`, because an icon alone says nothing to a screen reader.
- **Live turns** — a streaming assistant row writes into the row itself (`row._content`, `row._reasoning`), not into the placeholder message it was created from, so the button resolves its payload at click time through a closure rather than capturing a snapshot. A settled row simply returns its message object.
- **What a message copies** — `messageCopyText()` in [frontend/src/components/chat/utils.js](frontend/src/components/chat/utils.js) is the single place that decides this, so the button and any future copy entry point cannot disagree.
- **Clipboard access** — the same module exports `copyText()`, which tries `navigator.clipboard.writeText()` and falls back to a hidden `textarea` + `document.execCommand('copy')` for embedded web views and non-secure origins. It returns a boolean rather than throwing, so the button can report a refusal in place. The helper mirrors the ones already used by `chat/GitModal.jsx` and `Inspector.jsx`.
- **Styling** — `.chat-msg__actions` / `.chat-msg__copy` (with the `is-copied` / `is-failed` states) live in [frontend/src/chat-transcript.css](frontend/src/chat-transcript.css). The button takes the shared compact glyph box (`--tap-sm`, 32 px) with no border or label, and pairs it with `.tap-target` from [frontend/src/base.css](frontend/src/base.css) so the *hit* area still reaches the 44 px touch floor without painting a 44 px square. It inherits the row's alignment, so it sits under the right edge of a user bubble and the left edge of an assistant bubble.
- **Covered by** `scripts/test-message-copy.js` (wired into `npm run test:chat-view`): it asserts what each message shape copies, that the button is icon-only with a `currentColor` glyph and a `.tap-target` hit area, that the glyph flips on success, and that user/assistant rows mount the button while error cards mount only Retry.
