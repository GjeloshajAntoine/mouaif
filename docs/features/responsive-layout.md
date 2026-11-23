# Responsive layout

## Overview

The mouaif web UI is mobile-first: every surface is designed for a 360–430 px phone, then scales up to tablet and desktop. The app frame, every list view and the chat (bubbles, transcript cards, docks, the composer) follow the window's full width, from a phone up to a desktop or ultrawide screen.

Before this change the shell carried a hard `max-width: 30rem` (480 px). On a laptop that produced the worst of both layouts: the modals (`@media (min-width: 720px)`) and the Inspector (`@media (min-width: 900px)`) switched to their desktop branches — both written for a wide viewport — while the frame they were laid out in stayed 480 px, so the desktop UI was squeezed into a phone-width strip and the rest of the window stayed empty.

## Usage

No settings and no toggles: the layout responds to the window.

| Window width | App frame | Lists, groups, view heads, hints | Chat bubbles, cards, docks, composer, chat head |
| --- | --- | --- | --- |
| 360–430 px (phone) | viewport width | viewport width | 92% of the transcript |
| 430 px and wider (tablet, laptop, desktop, ultrawide) | viewport width | viewport width | full transcript width |

Earlier versions capped the frame at 1152 px, lists at 896 px and the chat at 704 px, which left wide empty gutters on a desktop and kept docks such as the Agents card from following the window. The caps are now off; setting a length on `--shell-max`, `--list-max` or `--read-max` in `base.css` brings one back.

- The header and tab bar paint to the frame edges. Without a top inset, the noninteractive brand occupies a 16 px row. The bottom tabs use a 24 × 24 px icon slot, but the full tab cell remains tappable and at least 44 px tall. The bar includes the bottom safe-area inset. Above 720 px, the tab labels stay grouped in the center.
- Every non-chat route renders its content as one column — the view head, hint paragraphs, groups, cards and page bars all share one column, so a title lines up with the rows under it instead of starting at the frame edge.
- Chat keeps the transcript scroller full width (the overlay scrollbar sits at the frame edge) while every row spans that scroller's inner box, so all rows — prose bubbles, thinking cards, tool cards, the system card — share one left edge and one right edge, and the rows span the full chat width on a wide window. The bubble inside still hugs its text from the shared left edge and user bubbles stay right-aligned. The chat head (back button, title, usage chips, model row) and the composer row share that same column.
- The chat transcript fills the full height between the chat head and the composer at every width, so the composer stays pinned to the bottom of the screen on a tablet or desktop. The transcript has no viewport-height cap; its flex sizing (`flex: 1 1 auto; min-height: 0`) is what bounds it.
- **Chats tab, from 720 px wide and 600 px tall:** a project's chat list grows with the window instead of stopping at about three rows (it shows up to a third of the window height). When only one project is registered, its card fills the view down to the tab bar, and the list scrolls inside it with the card's header and **+ New chat** footer kept in view. A short list still ends where its last chat does. A phone, including one turned sideways, keeps the compact three-row cards.
- **Settings tab, from 720 px wide:** the settings home uses two columns. Providers and This project are on the left, App defaults runs down the right (the slightly wider column, since its row descriptions are the long ones), and the footer note spans both.
- Modal sheets keep their own widths: the file editor and the other modal sheets keep their own card widths (520–1120 px) from `sheets.css` and `file-editor.css`.

## Toggle switches

The shared toggle (`.switch` in `forms.css`) paints a 42 × 26 px track and a 20 × 20 px thumb inside a 44 × 44 px hit box, so the painted control stays compact while the tap target meets the 44 px mobile minimum. The track is centred on the box with `left: 50% / top: 50%` plus a `translate(-50%, -50%)`, and the thumb is positioned against the track rather than the box.

This is deliberately *not* `inset: 0` on the track. A duplicated `.switch__track` rule once stretched the track to the box and re-anchored it to the box's content origin; because the box establishes the containing block for the absolutely positioned thumb, the track and thumb then escaped the control to the left (`left: -11px`) and painted half off-screen on a 390 px phone — visible on Settings → Custom prompts, where the "Add to project card" switch rendered as a clipped sliver at the row's left edge. Any future consolidation of this rule must keep the track centred and the thumb inside the track.

The responsive regression asserts the geometry directly: for `settingsPrompts` it checks that the control is ≥ 44 px, that both the track and the thumb sit inside the control's box, and that neither paints outside the viewport.

## Segmented controls

On a touch screen (`pointer: coarse`) a standalone segmented control — MCP server scope and transport, action type, custom prompt scope, the MCP store's install options — is 44 px tall: a 38 px pill inside the control's 2 px padding and 1 px border. With a mouse it keeps its compact 32 px. The Off/Ask/Allow segment inside a tool-tree row stays compact on every device, because the tree's rows are deliberately dense (see [Tool tree](tool-tree.md)).

## Desktop behaviour

- Dictation keeps a narrower, centred column than general lists, so its controls and transcript remain easy to read on a large screen.
- Chat messages stay aligned with the header and composer even when a desktop scrollbar occupies space.
- Transcript navigation and the web preview dock follow the conversation instead of drifting into the frame's empty right gutter. Navigation floats over the transcript's corner rather than occupying a row of its own, so the transcript keeps the full height between the chat head and the composer and no second toolbar sits between the messages and the composer.

### Verification

Run the browser regression with an installed Chrome/Chromium (or set `CHROME_PATH`):

```bash
node scripts/test-responsive-layout.mjs
```

It mounts the real app shell with local API fixtures and checks Chats, Settings, Chat defaults, Dictation, Custom prompts, and Chat at 360–1920 px, including shorter windows and larger root text. It verifies horizontal fit, that the frame follows the window, a visible composer, preview/navigation placement, flush-settings scrolling, and (on Custom prompts) that the toggle switch paints inside its own control. It does not start or restart `mouaif serve`.

## Related

- [Inspector](inspector.md) — the desktop panel layout this frame now has room for.
- [Foldable phones](foldable-layout.md) — fold sizes and the half-folded chat layout.
- [Chat UI](chat-ui.md) — transcript and composer surfaces.
