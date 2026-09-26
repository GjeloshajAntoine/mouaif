# Chat scroll navigation

## Overview

A small stack of round arrows floats over the bottom-right corner of the chat transcript. Use it to step to the previous message, step to the next message, or jump back to the bottom, without long swipes through a long agentic chat.

## Usage

| Arrow | What it does | When it shows |
| --- | --- | --- |
| **↑ Previous message** | Scrolls so the start of the message you are reading sits at the top. Tap again to go to the message before it. Past the first message it goes to the very top, which also loads older messages. | When the transcript is longer than the screen. |
| **↓ Next message** | Scrolls so the start of the next message sits at the top. After the last message it goes back to the bottom. | After you scroll up. |
| **⤓ Bottom** | Goes back to the newest message and follows the reply again. A number next to it counts the rows that arrived while you were scrolled up. | After you scroll up. |

- The arrows step between **messages** (yours, the assistant's, and system notes). Tool cards are skipped, so one tap does not stop at every command in an agentic turn.
- Tapping ↑ or ↓ stops auto-follow, as scrolling up does. A streaming reply keeps arriving below, and the Bottom arrow's counter goes up.
- Each arrow is a small 26 px circle, so it covers little of the text beneath it. Its tap area is still 44 × 44 px, and the arrows are spaced so their tap areas never overlap. The arrows sit inside the right safe-area inset and work by tap alone. Nothing depends on hover.
- The arrows float just above the transcript's bottom edge. They move up with it when the composer grows (a multi-line draft, the web-preview dock), so they never sit on the composer.

## Implementation notes

- The rail lives in `.chat-view__transcript-box`, a positioned wrapper that takes the transcript's flex slot. The rail's `bottom` is measured from the transcript itself, not a fixed offset from the bottom of the chat view.
- A single tap always moves the view by at least 48 px, which is the `isNearBottom()` pin threshold. Without that floor, "previous" at the bottom picked the row cut off a few pixels above the top edge. The tap then barely moved the view, landed back inside the pin band, and re-pinned straight away, so the arrow looked dead.
- "Next" re-pins when the next row can never reach the top, because the view is already scrolled as far as it goes. The rail then returns to its pinned state, rather than unpinning with nothing left to scroll.
- Transcript rows have `flex-shrink: 0`. The transcript is a height-bounded flex column, and an off-screen `content-visibility: auto` row has a min-content height of 0. Shrinkable rows therefore collapsed to nothing, which broke both the scrollbar and the row offsets the arrows jump to.
- `node scripts/chat-scroll-nav-fixture.mjs [port]` serves the real chat view with a long fake transcript and in-page API stubs. Open it at a phone viewport to check the arrows by hand. `scripts/test-chat-scroll-nav.mjs` covers the stepping logic.
