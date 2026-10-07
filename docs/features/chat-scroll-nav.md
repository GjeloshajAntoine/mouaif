# Chat scroll navigation

## Overview

Small icon-only controls float over the transcript's bottom-right corner: a fixed **Prev / Next** message-navigation row and a separate **Latest** action above it. Repeated taps stay on the same target when you leave or return to live output. The overlay takes no reading height from the transcript.

## Usage

| Arrow | What it does | When it shows |
| --- | --- | --- |
| **↑ Previous message** | Scrolls so the start of the message you are reading sits at the top. Tap again to go to the message before it. Past the first message it goes to the very top, which also loads older messages. | When the transcript is longer than the screen. |
| **↓ Next message** | Scrolls so the start of the next message sits at the top. After the last message it goes back to the bottom. | Always beside Prev when history overflows; disabled while following latest. |
| **⤓ Latest** | Goes back to the newest message and follows the reply again. A number next to it counts the rows that arrived while you were scrolled up. | After you scroll up, in its own slot above Prev / Next. |

- The controls step between **messages** (yours, the assistant's, and system notes). Tool cards are skipped, so one tap does not stop at every command in an agentic turn.
- Tapping ↑ or ↓ stops auto-follow, as scrolling up does. A streaming reply keeps arriving below, and Latest's counter goes up. These controls jump between messages, not pages: swipe or use Space/PageDown to read through a long answer without skipping its remainder.
- Prev and Next occupy **fixed grid slots**. Showing Latest or growing its unread badge does not move either message-navigation target horizontally or vertically.
- Each control stays **glyph-only and small**: a 26 × 26 px pill inside a 44 × 44 px transparent hit area. Nothing is painted over the text it floats above, and no label is drawn: the accessible name lives in `aria-label` / `title`, which screen readers and long-press tooltips still show.
- The rail's grid slots are 44 px wide with a 4 px gap, so each hit area fills its own slot and never overlaps a neighbour's. There are no invisible tap extensions reaching across controls.
- The cluster follows the centred reading column on wide screens, keeps clear of the composer and the web-preview dock, and hides when there is no scrollable history.
- A **top-level progress card reserves the control row's width** on its right (the `report_progress` row) so the floating cluster never covers its percentage. Other transcript content can still pass beneath the overlay.

## Space, Tab, and the arrow keys

The transcript and enabled navigation buttons are in the **Tab order**, with visible focus outlines. Focus the transcript to scroll with Space, PageUp, PageDown, and the arrow keys; focus a button to activate it with Space or Enter. Disabled Next is skipped while following latest.

Activating Latest resumes auto-follow and returns focus to the transcript before hiding that button, without changing the scroll position as a side effect of focus.

## Implementation notes

The overlay uses two explicit grid rows of 44 px slots: Latest spans the upper row, and Prev / Next occupy the lower row, so a 26 px pill's expanded hit area stays inside its own slot. The Latest slot remains allocated when hidden, and Next stays rendered but disabled while pinned. Latest's unread badge is the only text any control renders. Pin-state changes remain imperative in `scroll.js`, so ordinary scrolling does not rerender Preact.

## Verification

Run the scrolling and browser-layout regressions with installed Chrome/Chromium (or `CHROME_PATH`):

```bash
npm run test:chat-view
node scripts/test-responsive-layout.mjs
```

The layout regression checks phone widths from 360–430 px, larger viewports and enlarged fonts. It asserts 44 px hit areas around 26 px painted controls, the absence of visible labels, stable button coordinates across pin changes and a `99+` badge, repeat taps at the same coordinates, keyboard reachability, Space scrolling a focused transcript, and keyboard activation of Latest with focus restored. It also confirms the overlay reserves no reading row.

