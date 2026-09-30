# Chat row identity

## Overview

The chat shows some messages before the server has saved them: your message the moment you send it, each reply segment as it streams, a direct `@agent` answer, and a stream error. Each of these rows now carries its own id from the moment it is drawn. When the saved copy comes back from the server, it replaces the row with the same id, so a message never shows twice, never swaps places with its neighbour, and never jumps when the transcript syncs.

## Usage

There is nothing to turn on. It applies to every chat:

- **Send a message.** Your bubble appears at once and stays in place when the server confirms it. Sending the same text twice in a row, or from two tabs, still gives two separate bubbles in the right order.
- **Watch a reply stream.** Each segment keeps its bubble when it is saved, including segments separated by tool calls.
- **Retry a failed send.** The retry reuses the id of the bubble already on screen, so a retry never adds a second copy of your message.
- **Hit a stream error.** The error card is replaced in place by the saved error row, even when it sits in the middle of the transcript.
- **Open an old chat.** Messages saved before this change have no id and keep working as before.

## Behavior

- An id is a short random string such as `u_3k9x…` (`u` user, `a` assistant, `e` error, `g` agent answer). Ids are unique within a chat. If a retry re-sends an id the server already stored, the server gives the new row a fresh id, so two rows never share one.
- A saved row whose id this tab never drew (a turn sent from another tab or device) is placed by its position in the conversation. It can never take the place of one of this tab's own pending rows, even when the text is identical.
- Tool calls and results are identified by their tool call id, as before. They do not get a row id.

## Related

- [Chat transcript rendering](./chat-transcript-rendering.md) — rows are reused instead of rebuilt.
- [Chat storage](./chat-storage.md) — where messages are saved.
- [Chat backward pagination](./chat-backward-pagination.md) — the same saved-row cursor drives older pages.
