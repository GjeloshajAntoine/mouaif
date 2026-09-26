# Responsive layout

## Overview

The mouaif web UI is mobile-first: every surface is designed for a 360–430 px phone, then scales up to tablet and desktop. The app frame grows with the window up to 1152 px instead of staying a 480 px phone column, and long-form surfaces (chat bubbles, transcript cards, the composer) keep a readable measure inside that frame.

Before this change the shell carried a hard `max-width: 30rem` (480 px). On a laptop that produced the worst of both layouts: the modals (`@media (min-width: 720px)`) and the Inspector (`@media (min-width: 900px)`) switched to their desktop branches — both written for a wide viewport — while the frame they were laid out in stayed 480 px, so the desktop UI was squeezed into a phone-width strip and the rest of the window stayed empty.

## Usage

No settings and no toggles: the layout responds to the window.

| Window width | App frame | Lists, groups, view heads, hints | Chat bubbles, cards, composer, chat head |
| --- | --- | --- | --- |
| 360–430 px (phone) | viewport width | viewport width | 92% of the transcript |
| 430–899 px (large phone, portrait tablet) | viewport width | viewport width | 92% of the transcript |
| 900–1152 px (tablet, small laptop) | viewport width | capped at 896 px, centred | capped at 704 px, centred |
| 1152 px and wider (desktop, ultrawide) | capped at 1152 px, centred | capped at 896 px, centred | capped at 704 px, centred |

- The header and the tab bar paint to the edges of the frame; above 720 px the three tab labels keep a comfortable width instead of stretching across the frame.
- Every non-chat route renders its content as one column — the view head, hint paragraphs, groups, cards and page bars all share the 896 px measure, so a title lines up with the rows under it instead of starting at the frame edge.
- Chat keeps the transcript scroller full width (the overlay scrollbar sits at the frame edge) while every row spans that scroller's inner box, so all rows — prose bubbles, thinking cards, tool cards, the system card — share one left edge and one right edge, and long text keeps the 704 px readable measure on a wide frame. The bubble inside still hugs its text from the shared left edge and user bubbles stay right-aligned. The chat head (back button, title, usage chips, model row) and the composer row are centred on the same measure, so the controls stop a screen apart from each other on a wide window.
- The chat transcript fills the full height between the chat head and the composer at every width, so the composer stays pinned to the bottom of the screen on a tablet or desktop. The transcript has no viewport-height cap; its flex sizing (`flex: 1 1 auto; min-height: 0`) is what bounds it.
- Wide tool surfaces do not join the 896 px column: the file editor and the other modal sheets keep their own card widths (520–1120 px) from `sheets.css` and `file-editor.css`.

## Related

- [Inspector](inspector.md) — the desktop panel layout this frame now has room for.
- [Chat UI](chat-ui.md) — transcript and composer surfaces.
