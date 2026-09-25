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

The control is built by `buildCopyButton` in [frontend/src/components/chat/transcript.js](../../frontend/src/components/chat/transcript.js) and styled by `.chat-msg__copy` in [frontend/src/chat-transcript.css](../../frontend/src/chat-transcript.css).

- **Compact painted box, legal tap area.** The glyph is the whole button, so the painted box is the smallest glyph-control size, `--tap-xs` (26px in [frontend/src/base.css](../../frontend/src/base.css)) — smaller than the `--tap-sm` send / MCP toggles because it repeats under every bubble. `.tap-target` expands the hit area to the `--tap` floor (44px) without painting it, so the mobile-first tap rule still holds.
- **State lives in the glyph.** The three SVGs are `COPY_GLYPH_IDLE` / `_COPIED` / `_FAILED`, drawn in `currentColor`; the CSS tint (muted → success / danger) is the only color decision. The glyph and the `aria-label` / `title` flip together, so the state is never carried by color alone.

