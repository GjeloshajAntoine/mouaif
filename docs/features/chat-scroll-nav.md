# Chat scroll navigation

## Overview

A compact row of arrows sits below the chat transcript and above the composer. Use it to step to the previous message, step to the next message, or jump back to the bottom without long swipes or controls covering message text.

## Usage

| Arrow | What it does | When it shows |
| --- | --- | --- |
| **↑ Previous message** | Scrolls so the start of the message you are reading sits at the top. Tap again to go to the message before it. Past the first message it goes to the very top, which also loads older messages. | When the transcript is longer than the screen. |
| **↓ Next message** | Scrolls so the start of the next message sits at the top. After the last message it goes back to the bottom. | After you scroll up. |
| **⤓ Bottom** | Goes back to the newest message and follows the reply again. A number next to it counts the rows that arrived while you were scrolled up. | After you scroll up. |

- The arrows step between **messages** (yours, the assistant's, and system notes). Tool cards are skipped, so one tap does not stop at every command in an agentic turn.
- Tapping ↑ or ↓ stops auto-follow, as scrolling up does. A streaming reply keeps arriving below, and the Bottom arrow's counter goes up.
- Each arrow is a real button at least 44 × 44 px. The visible button, keyboard focus ring, and touch target share the same box; no invisible hit areas overlap messages or neighbouring controls. The row respects horizontal safe-area insets and works by tap alone.
- The navigation row stays outside the scrolling message area. It never covers message text, copy buttons, or tool-card percentages, and stays above the composer when a multi-line draft or web-preview dock grows.
- The row follows the centred reading column on wide screens. It disappears when there is no scrollable history, and keeps the same height when Next and Bottom appear.

## Verification

Run the scrolling and browser-layout regressions with installed Chrome/Chromium (or `CHROME_PATH`):

```bash
npm run test:chat-view
node scripts/test-responsive-layout.mjs
```
