# Chat scroll navigation

## Overview

A small cluster of arrow controls floats over the transcript's bottom-right corner. Use it to step to the previous message, step to the next message, or jump back to the bottom without long swipes. It is an overlay, not a bar: it takes no reading height from the transcript.

## Usage

| Arrow | What it does | When it shows |
| --- | --- | --- |
| **↑ Previous message** | Scrolls so the start of the message you are reading sits at the top. Tap again to go to the message before it. Past the first message it goes to the very top, which also loads older messages. | When the transcript is longer than the screen. |
| **↓ Next message** | Scrolls so the start of the next message sits at the top. After the last message it goes back to the bottom. | After you scroll up. |
| **⤓ Bottom** | Goes back to the newest message and follows the reply again. A number next to it counts the rows that arrived while you were scrolled up. | After you scroll up. |

- The controls step between **messages** (yours, the assistant's, and system notes). Tool cards are skipped, so one tap does not stop at every command in an agentic turn.
- Tapping ↑ or ↓ stops auto-follow, as scrolling up does. A streaming reply keeps arriving below, and the Bottom control's counter goes up.
- The cluster is **stacked vertically** in the transcript's bottom-right corner and grows **upward** when Next and Bottom appear, so the control you were aiming at never moves under your finger.
- Each control paints at 26 px with a transparent hit area grown to 44 × 44 px. Controls are stacked, so their expanded areas meet in the gap between them instead of overlapping a neighbour.
- The cluster follows the centred reading column on wide screens, keeps clear of the composer and the web-preview dock, and hides when there is no scrollable history.
- A **top-level progress card reserves a 34 px strip** on its right (the `report_progress` row) so the floating cluster never covers its percentage.

## Space, Tab, and the arrow keys

The controls are **tap-only**, and are deliberately held out of the tab order.

This is not a styling choice. A focusable button **swallows <kbd>Space</kbd>**: the browser activates the focused element instead of scrolling its scroll container. Tabbing onto the cluster therefore turned the most natural "scroll down" key into "jump to the previous message", and parked a focus ring over the transcript. Every action the cluster offers is reachable by tap, and the transcript itself keeps <kbd>Space</kbd>, <kbd>PageUp</kbd>, <kbd>PageDown</kbd>, and the arrow keys.

## Verification

Run the scrolling and browser-layout regressions with installed Chrome/Chromium (or `CHROME_PATH`):

```bash
npm run test:chat-view
node scripts/test-responsive-layout.mjs
```

The layout regression asserts the rail's computed `position`, that the transcript reaches the surface below it (no reserved row), that a 44 px hit area survives on every control, that <kbd>Tab</kbd> never reaches the rail, and that <kbd>Space</kbd> scrolls instead of jumping a message.

