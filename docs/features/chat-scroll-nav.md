# Chat scroll navigation

## Overview

A small navigation rail rests against the transcript's right edge, a third of the way down, folded into a short stack of dots. Tap the dots and it unfolds into four icon-only controls — **Top**, **Previous message**, **Next message**, **Latest** — which fold back again when you tap anywhere else. Nothing is reserved for the rail: messages keep their full reading width and the transcript keeps its full height. Repeated taps stay on the same target when you leave or return to live output.

## Usage

| Control | What it does | When it shows |
| --- | --- | --- |
| **⤒ Top** | Jumps to the start of the transcript, which also loads older messages. | When the transcript is longer than the screen. |
| **↑ Previous message** | Scrolls so the start of the message you are reading sits at the top. Tap again to go to the message before it. | When the transcript is longer than the screen. |
| **↓ Next message** | Scrolls so the start of the next message sits at the top. After the last message it goes back to the bottom. | Always below Previous when history overflows; disabled while following latest. |
| **⤓ Latest** | Goes back to the newest message and follows the reply again. A small badge on its corner counts the rows that arrived while you were scrolled up. | After you scroll up. |

- **The rail starts folded.** It rests as four small dots joined into a short strip; a tap on the strip unfolds it into its controls. That tap never runs a control. A tap anywhere outside the rail folds it again, and focusing a control with the keyboard unfolds it too, so nothing is ever activated unseen.
- The rail's **centre is anchored a third of the way down** the transcript, on its right edge. Unfolded, the four slots grow evenly around that point, so the rail never drifts between its folded and unfolded states.
- The controls step between **messages** (yours, the assistant's, and system notes). Tool cards are skipped, so one tap does not stop at every command in an agentic turn.
- Tapping Top, Previous or Next stops auto-follow, as scrolling up does. A streaming reply keeps arriving below, and Latest's counter goes up. Previous and Next jump between messages, not pages: swipe or use Space/PageDown to read through a long answer without skipping its remainder.
- Top, Previous, Next and Latest occupy **fixed grid slots**. Folding, unfolding, showing Latest or growing its unread badge does not move any of the others horizontally or vertically.
- **Nothing is reserved for the controls.** Every transcript row uses the full reading column, so no message loses its characters to a strip, and the transcript keeps the full height between the chat head and the composer. The rail therefore sits over a short stretch of the transcript's right edge at mid-height, which is the price of giving every message its full width back.
- **The rail is flush with the chat's right edge,** over the lane the transcript's scrollbar occupies. It covers only a short stretch of a thin bar, and the bar stays draggable above and below it.
- Each control stays **glyph-only and small**: a 20 × 20 px pill whose transparent hit area fills its 28 × 28 px slot. No label is drawn: the accessible name lives in `aria-label` / `title`, which screen readers and long-press tooltips still show. Latest's unread badge sits on the pill's corner, so `99+` stays inside the control's own 28 px column.
- The column's slots are 28 px tall with a 2 px gap, so each hit area fills its own slot and never overlaps a neighbour's.
- The folded rail carries its own tap target — a 28 × 40 px strip around the dots — because the controls' hit areas fold down with them.
- The rail hides when there is no scrollable history.

## Space, Tab, and the arrow keys

The transcript and the navigation buttons are in the **Tab order**, with visible focus outlines; focusing one unfolds the rail. Focus the transcript to scroll with Space, PageUp, PageDown, and the arrow keys; focus a button to activate it with Space or Enter. Disabled Next is skipped while following latest.

Activating Latest resumes auto-follow and returns focus to the transcript before hiding that button, without changing the scroll position as a side effect of focus.

## Verification

Run the scrolling and browser-layout regressions with installed Chrome/Chromium (or `CHROME_PATH`):

```bash
npm run test:chat-view
node scripts/test-responsive-layout.mjs
```

The layout regression checks phone widths from 360–430 px, larger viewports and enlarged fonts. It asserts the rail floats over the transcript, anchored at a fixed share of its height, folded at rest and unfolded on tap; that folded controls paint no glyph and stay inside the rail's column; that the folded strip is itself tappable; that the four slots keep 28 px hit areas around 20 px painted controls, the absence of visible labels, stable button coordinates across pin changes and a `99+` badge, repeat taps at the same coordinates, keyboard reachability and focus unfolding the rail, Space scrolling a focused transcript, keyboard activation of Latest with focus restored, and Top reaching the start of the transcript. It also confirms the rail reserves no reading height and no reading *width*: every row still reaches the reading column, the `99+` badge stays inside the rail's own column, and where a classic scrollbar has a lane it stays draggable above and below the rail.
