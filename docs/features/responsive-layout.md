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

## Toggle switches

The shared toggle (`.switch` in `forms.css`) paints a 42 × 26 px track and a 20 × 20 px thumb inside a 44 × 44 px hit box, so the painted control stays compact while the tap target meets the 44 px mobile minimum. The track is centred on the box with `left: 50% / top: 50%` plus a `translate(-50%, -50%)`, and the thumb is positioned against the track rather than the box.

This is deliberately *not* `inset: 0` on the track. A duplicated `.switch__track` rule once stretched the track to the box and re-anchored it to the box's content origin; because the box establishes the containing block for the absolutely positioned thumb, the track and thumb then escaped the control to the left (`left: -11px`) and painted half off-screen on a 390 px phone — visible on Settings → Custom prompts, where the "Add to project card" switch rendered as a clipped sliver at the row's left edge. Any future consolidation of this rule must keep the track centred and the thumb inside the track.

The responsive regression asserts the geometry directly: for `settingsPrompts` it checks that the control is ≥ 44 px, that both the track and the thumb sit inside the control's box, and that neither paints outside the viewport.

## Desktop behaviour

- Dictation keeps a narrower, centred column than general lists, so its controls and transcript remain easy to read on a large screen.
- Chat messages stay aligned with the header and composer even when a desktop scrollbar occupies space.
- Transcript navigation and the web preview dock follow the conversation instead of drifting into the frame's empty right gutter. Navigation floats over the transcript's corner rather than occupying a row of its own, so the transcript keeps the full height between the chat head and the composer and no second toolbar sits between the messages and the composer.

### Verification

Run the browser regression with an installed Chrome/Chromium (or set `CHROME_PATH`):

```bash
node scripts/test-responsive-layout.mjs
```

It mounts the real app shell with local API fixtures and checks Chats, Settings, Chat defaults, Dictation, Custom prompts, and Chat at 360–1920 px, including shorter windows and larger root text. It verifies horizontal fit, centred measures, a visible composer, preview/navigation placement, flush-settings scrolling, and (on Custom prompts) that the toggle switch paints inside its own control. It does not start or restart `mouaif serve`.

## Related

- [Inspector](inspector.md) — the desktop panel layout this frame now has room for.
- [Chat UI](chat-ui.md) — transcript and composer surfaces.
