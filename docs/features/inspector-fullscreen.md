# Inspector full screen

Expand one Inspector panel over the whole viewport, from the button in its own card header.

## Overview

The Inspector stacks its panels as cards inside the tab: Preview, Styles, Console, Network and Info, each with its own scroll area. On a phone that leaves every panel body between 32 and 54 `dvh` tall — under half the screen — which is workable for a glance and cramped for the tasks the panels exist for: reading a computed-styles list of ~470 rows, scanning a request log, or scrolling a console back through a noisy page.

Every card header therefore carries a **full-screen button**. Tapping it expands that panel over the whole viewport; tapping it again returns to the stacked layout exactly as you left it.

The header used to print the panel's name in that slot. It no longer does: the name is what the chip in the switcher above the cards already says, and the row's one wide slot is worth more as an action. The button carries the panel's name in its accessible label, so nothing becomes unnameable for assistive technology.

## Usage

1. Open the **Inspector** tab and connect to a page.
2. Find the panel you want to enlarge (its chip in the switcher row shows which are visible).
3. Tap the **expand** glyph at the left of that panel's header.
4. Work as normal — the panel is the same live surface, just larger. Everything the panel does inline still works: selecting elements, editing values, evaluating in the console, tapping the preview.
5. Tap the glyph again, or press **Escape**, to return to the stacked layout.

### Which panel you get

| Card | What its full-screen button opens |
| --- | --- |
| Preview | The panel's own **viewport-spanning live preview**, unchanged: a second screenshot surface with the live page's title + host, Refresh, Capture size, zoom and its own close button. |
| Styles | The card expanded over the viewport, with its style controls, property lists and matched rules. |
| Console | The card expanded over the viewport: the log list plus the JavaScript console below it. |
| Network | The card expanded over the viewport. |
| Info | The card expanded over the viewport. |

Preview keeps its own overlay because it already had a fuller full screen — a second surface with its own header, viewport presets and "type into page" bar — and replacing it with the generic one would lose controls rather than gain space.

### Leaving full screen

Any of these returns you to the stacked layout:

- **Escape.**
- Tapping the same header button again (the glyph now points inward).
- Switching the expanded panel off with its eye toggle. Opening a different panel card is never blocked by the mode; the mode is simply left.
- Detaching from the inspected tab.
