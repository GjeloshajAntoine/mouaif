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
