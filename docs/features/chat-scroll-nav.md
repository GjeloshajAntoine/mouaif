# Chat scroll navigation

## Overview

Small icon-only controls sit in a narrow column of their own at the transcript's bottom-right: **Prev**, **Next**, then **Latest**. Messages never run under them. Repeated taps stay on the same target when you leave or return to live output. The column takes no reading height from the transcript.

## Usage

| Arrow | What it does | When it shows |
| --- | --- | --- |
| **↑ Previous message** | Scrolls so the start of the message you are reading sits at the top. Tap again to go to the message before it. Past the first message it goes to the very top, which also loads older messages. | When the transcript is longer than the screen. |
| **↓ Next message** | Scrolls so the start of the next message sits at the top. After the last message it goes back to the bottom. | Always below Prev when history overflows; disabled while following latest. |
| **⤓ Latest** | Goes back to the newest message and follows the reply again. A small badge on its corner counts the rows that arrived while you were scrolled up. | After you scroll up, in its own slot below Prev / Next. |

- The controls step between **messages** (yours, the assistant's, and system notes). Tool cards are skipped, so one tap does not stop at every command in an agentic turn.
- Tapping ↑ or ↓ stops auto-follow, as scrolling up does. A streaming reply keeps arriving below, and Latest's counter goes up. These controls jump between messages, not pages: swipe or use Space/PageDown to read through a long answer without skipping its remainder.
- Prev and Next occupy **fixed grid slots**. Showing Latest or growing its unread badge does not move either message-navigation target horizontally or vertically.
- **The controls never cover a message.** Every transcript row ends before a narrow 28 px strip on the right, and the controls stay inside it. On a wide screen, where there is room beside the centred reading column, they sit just past it and the rows keep their full width.
- Each control stays **glyph-only and small**: a 20 × 20 px pill whose transparent hit area fills its 28 × 28 px slot. No label is drawn: the accessible name lives in `aria-label` / `title`, which screen readers and long-press tooltips still show. Latest's unread badge sits on the pill's corner, so `99+` stays inside the strip.
- The column's slots are 28 px tall with a 2 px gap, so each hit area fills its own slot and never overlaps a neighbour's.
- The column keeps clear of the composer and the web-preview dock, and hides when there is no scrollable history.

## Space, Tab, and the arrow keys

The transcript and enabled navigation buttons are in the **Tab order**, with visible focus outlines. Focus the transcript to scroll with Space, PageUp, PageDown, and the arrow keys; focus a button to activate it with Space or Enter. Disabled Next is skipped while following latest.

Activating Latest resumes auto-follow and returns focus to the transcript before hiding that button, without changing the scroll position as a side effect of focus.

## Verification

Run the scrolling and browser-layout regressions with installed Chrome/Chromium (or `CHROME_PATH`):

```bash
npm run test:chat-view
node scripts/test-responsive-layout.mjs
```

The layout regression checks phone widths from 360–430 px, larger viewports and enlarged fonts. It asserts 28 px hit areas around 20 px painted controls, the absence of visible labels, stable button coordinates across pin changes and a `99+` badge, repeat taps at the same coordinates, keyboard reachability, Space scrolling a focused transcript, and keyboard activation of Latest with focus restored. It also confirms the column reserves no reading row and that no row's right edge passes the controls' left edge, `99+` badge included.

