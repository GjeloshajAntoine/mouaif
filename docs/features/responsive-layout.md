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
- Wide tool surfaces do not join the 896 px column: the file editor and the other modal sheets keep their own card widths (520–1120 px) from `sheets.css` and `file-editor.css`.

## Implementation notes

The three stops are custom properties in `frontend/src/base.css`:

```css
--shell-max: 72rem;   /* 1152px */
--list-max:  56rem;   /*  896px */
--read-max:  44rem;   /*  704px */
```

They are consumed in four places, all keyed off the frame rather than the viewport, so a phone is unaffected (every cap is inert below its own width):

- `frontend/src/layout.css` — `.app__shell` grows to `--shell-max` and centres; inside `@media (min-width: 900px)`, every direct child of `.app__main` except the chat view is capped at `--list-max` and centred with `margin-inline: auto`; `.app__tablist` caps at 32rem inside a `@media (min-width: 720px)` block so a phone keeps the full-bleed tappable bar.
- `frontend/src/chat-view.css` — `.chat-view__head` is capped at `--read-max` and centred, so the back button, title and icon column stay on the same measure as the transcript below.
- `frontend/src/chat-transcript.css` — every direct child of `.chat-view__transcript` is a full-width row (`align-self: stretch; width: 100%`) capped at `--read-max` and centred, so all rows share one left and right edge and short rows cannot shrink and float to the middle; assistant rows use `align-items: flex-start` so the bubble inside still hugs its text from that shared edge, and `.chat-msg__body` is capped at `max-width: 100%` so a long unbreakable token cannot overflow its row.
- `frontend/src/chat-composer.css` — `.chat-view__composer-row` is capped at `--read-max` and centred.

Two constraints shaped the approach:

- **Container width, not viewport width.** Everything is capped by a max width on the frame, the content column or the row itself, never by a new breakpoint that could disagree with the existing `720px` / `900px` modal and Inspector branches. Between 900 px and 1152 px the frame equals the viewport, so those viewport-based branches stay truthful.
- **A definite row width, not a stretch plus auto margins.** The first attempt capped the rows and left them `align-self: flex-start`, which put all the slack on the right; the second added `margin-inline: auto`, which *cancels* the stretch — so a row sized to its content, and a short row floated to the middle of the transcript instead of lining up with the long rows around it. Transcript rows therefore set `width: 100%` with a `max-width` measure: the box is pinned to the full inner width (or to the measure on a wide frame) and can never shrink to fit-content. The content column rule is wrapped in `@media (min-width: 900px)` so that below that width an element's own inline margin (for example a hint paragraph's 10 px gutter) is never clobbered on a phone.

Touch targets are unchanged: the frame, the tab bar and every row keep their ≥ 44 px sizing at all widths.

## Related

- [.github/copilot-instructions.md](../../.github/copilot-instructions.md) §2 — mobile-first UI rules.
- [Inspector](inspector.md) — the desktop panel layout this frame now has room for.
- [Chat UI](chat-ui.md) — transcript and composer surfaces.
