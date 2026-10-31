# Foldable phones

## Overview

mouaif works on foldable phones in every way they are held: closed on the narrow cover screen, opened flat on the near-square inner screen, and half-folded. When the phone is half-folded, the chat moves its controls to the other side of the hinge, so nothing is placed across the fold.

| Posture | What you see |
| --- | --- |
| Closed (cover screen, 320–344 px) | The normal phone layout. Everything fits without sideways scrolling. |
| Open flat (inner screen, about 690 × 830 px) | The normal layout with more room: chat bubbles keep 92% of the transcript width and lists use the full width. |
| Tabletop: half-folded, hinge across the screen | The chat title and transcript fill the top half. The composer, docks and status line fill the bottom half, like a laptop's screen and keyboard. |
| Book: half-folded, hinge down the screen | The chat title and transcript fill the left page. The composer and docks sit at the foot of the right page. |

When you fold or unfold, the layout changes in place. The page doesn't reload, and your draft, scroll position and open chat stay as they were.

## Usage

There's nothing to turn on. Open a chat and half-fold the phone; flatten it to go back to the single-column layout.

- **Tabletop** suits a phone standing on a table: read the reply on the upper half and type on the lower half, where the keyboard also opens.
- **Book** suits holding the phone like a book: the conversation fills one page and the message box stays on the other.
- On a dual-screen device with a physical seam, the seam becomes an empty gap. On a seamless fold the gap is zero.

Other screens (Chats, Settings, Dictation) keep their single-column layout in every posture. Their lists already fit both halves, and a list that scrolls across a seamless fold stays readable.

## Implementation notes

- The postures come from the browser's Viewport Segments API. The rules live in `frontend/src/fold.css` behind `@media (vertical-viewport-segments: 2)` (tabletop) and `@media (horizontal-viewport-segments: 2)` (book). They use the `env(viewport-segment-*)` values to find the hinge.
- A flat phone, the cover screen and browsers without the API all report one segment, so none of these rules apply there.
- The chat's bottom stack (web preview dock, agent network dock, run dock, composer, status line) is wrapped in `.chat-view__dock`. That wrapper is `display: contents` on a single screen, so it adds no box and the chat layout is unchanged.
- Book posture removes the frame's `--shell-max` cap so the frame starts at the screen's left edge and the segment offsets line up with it.

Check it with an emulated hinge (headless Chrome, no server needed):

```bash
node scripts/test-foldable-layout.mjs
FOLD_SHOTS=/tmp/fold-shots node scripts/test-foldable-layout.mjs   # also save a PNG per posture
```

`scripts/test-responsive-layout.mjs` also covers the fold sizes: 320 and 344 px cover screens, and the inner screen at 690 × 830, 830 × 690 and 884 × 1104.

## Related

- [Responsive layout](responsive-layout.md): how the phone layout grows on tablets and desktops.
- [Chat UI](chat-ui.md): the transcript and composer.
