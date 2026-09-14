# Inspector touch controls

## Overview

The **Style controls** section of the Inspector's Styles tab is a surface of
finger-sized widgets — segmented chips, sliders with − / + steppers, a tappable
box model, colour swatches and an **Add property** card sheet — for changing the
selected element's CSS without a keyboard. It exists because the property rows
that come before it can write anything but assume you already know that `display`
takes `flex`, that `gap` is a length, and that `justify-content` wants
`space-between`: knowing the CSS is exactly the tax a phone should not charge.

Selecting the element does not change: you still tap an element in the live
preview (or type a selector, or walk the element tree). The controls are what the
selection leads to.

## Usage

1. **Select an element** — tap **Pick**, then tap the element in the live preview;
   or type a selector and tap **Select**; or walk **Element tree** with the
   parents breadcrumb and the child chips. The sticky header keeps the element's
   label (`div#hero.card`) and its box size on screen.
2. **Choose a group** — the surface opens with six wrapped tab chips: **Layout**,
   **Spacing**, **Size**, **Text**, **Colour**, **Effects**. It opens on
   **Layout** for a flex or grid container and on **Spacing** otherwise, and a tab
   carries a dot when the element declares something in that group.
3. **Change a value** — every row is one property:
   - **Segments** (`display`, `align-items`, `justify-content`, `text-align`,
     `font-weight`, `position`, `border-style`, `box-shadow`) are chips with a
     glyph and a name. Tapping one writes it.
  - **Sliders** (`gap`, `font-size`, `line-height`, `letter-spacing`, corners,
  opacity, border width, width, height) drag between 0 and 100 % of the
  property's span, and are flanked by **− / +** steppers that write on tap.
  The row lays out as **`− slider +`**: the `−` stepper, the full-width slider,
  then the `+` stepper, so the slider takes the whole middle column rather than
  being squeezed into a corner.
  The read-out under the slider follows your finger; the write happens when you
  let go, so a drag is **one** change and **one** undo.
   - **Fine / Coarse** sets the step: Coarse is the design scale (`4px`, `0.1`),
     Fine is a quarter of it (`1px`, `0.05`).
   - **Unit chips** rewrite the value in another unit (`px`, `rem`, `%`) when the
     base size is known; a conversion the panel cannot do is shown disabled with
     the reason instead of a guessed number.
   - **Box model** draws the margin ring around the padding ring with the element
     in the middle. Tap any edge — `padding-top`, `margin-left` — and the slider
     underneath becomes that edge's.
   - **Colour rows** show a swatch plus the colours this page already uses for
     that property, so "the same green as the rest of the page" is one tap.
4. **Type instead, when you want to** — the value on the right of every row is a
   button that opens the same editor a declared row opens: exact typing, the
   value-type switch, the unit row, the value rail and the page's own suggestions.
   A control never replaces it, and nothing here can express anything the editor
   cannot.
5. **Add a property** — **＋ Add property** opens the card sheet: search every
property, filter by category (All / Layout / Spacing / Size / Type / Colour /
Effects), or tap one of the suggested chips. Each card draws a small picture of
what the property does and says **Choose**, or **Edit** with the value the
element has now. Picking a card opens the value editor on that property.
  Switching category, or typing in the search field, brings the sheet back to
  its top: both replace every card below the controls, and the chip row and
  search field are what you need in view to choose again. The sheet's header
  (**Add a property** / **Close**) is pinned at the top of the sheet and stays
  there while the cards scroll.
6. **Check and undo** — the receipt above the controls lists every change with the
   value it replaced. Each row's ↺ restores it; **Undo all** reverses the session.
   **Refresh** re-reads the element after an outside change, and **Clear** drops
   the selection (and closes the card sheet).

```text
Layout    display · position · (flex) direction, align items, justify, gap
Spacing   margin · padding box model
Size      width · height · corners
Text      font size · weight · line height · tracking · align · colour
Colour    background · border colour
Effects   opacity · shadow · border style · border width
```

## Behavior

- **Everything writes the element's own inline style.** The touch surface uses the
  same write path as a declared row (`element.style.setProperty` through CDP), so
  a chip and a typed value are indistinguishable in the receipt, in the
  changed-first highlight and in the undo.
- **One write per gesture.** A slider previews on `input` and writes on `change`
  (release); chips and steppers write on tap. Dragging the gap slider across its
  whole span is one receipt entry, not sixty.
- **Only the controls that apply are shown.** A Block element's Layout tab offers
  Display and Position and nothing else; choosing **Flex** adds direction,
  alignment and gap on the next render, and choosing Block takes them away. This
  is why the group is a *view* of the element rather than a fixed form.
- **A control shows the value in force.** The element's own declaration wins;
  otherwise the computed value answers, so a value supplied by a class is visible
  and one tap from being overridden on the element. The `set` chip on a row marks
  a property the element declares itself.
- **A shorthand counts as set through its longhands.** The CSSOM stores
  `padding: 12px 8px` as four longhands, so the add-property card reads
  `12px 8px` and the row's `set` chip is honest about it.
- **A value that is not a number is not lied about.** With `width: auto` the
  slider and both steppers are disabled and the row says so; the value editor, or
  the **Auto** / **100 %** chips, remain the paths.
- **Edits are reversible.** Nothing is written until a tap or a release, and every
  write is one receipt entry with the value it replaced.

## Implementation notes

- **Files.** [`frontend/src/components/inspector/styleControls.js`](../../frontend/src/components/inspector/styleControls.js)
  is the pure model — the control catalog, the range specs, value parsing, the
  step/percent maths, the unit conversions, the box-model edges and the
  add-property library (no Preact, no DOM, no CDP).
  [`frontend/src/components/inspector/StyleControls.jsx`](../../frontend/src/components/inspector/StyleControls.jsx)
  renders it;
  [`frontend/src/components/inspector/AddPropertySheet.jsx`](../../frontend/src/components/inspector/AddPropertySheet.jsx)
  is the card sheet;
  [`frontend/src/inspector-touch.css`](../../frontend/src/inspector-touch.css) is
  the styling, imported by `frontend/src/inspector.css`.
- **The card picture is `inspector__propcard`, not `inspector__preview`.** The
  card sheet's thumbnail was originally `.inspector__preview` — the name the
  Preview panel already uses for its live page screenshot. Because
  `inspector-touch.css` is imported *after* `inspector-targets.css`, the card
  rule won: the live preview became a 52 × 52 card, and its
  `overflow: hidden` clipped the preview frame to a ~38 px column — which in
  turn collapsed the type bar into a 20 px input and pushed its Send button off
  the left edge of the panel, and tripped the preview's auto-fit heuristic into
  permanently choosing natural (panned) size. One stylesheet section silently
  re-laid out a different panel. The classes are namespaced
  (`.inspector__propcard`, `-box`, `-mark`, `-glyph`) so the two surfaces cannot
  collide again, and `scripts/test-inspector-touch-controls.js` asserts that the
  touch sheet contains no `.inspector__preview` selector at all.
- **Choosing a category returns the sheet to its top, and the sheet keeps a
  height ceiling without `dvh`.** Two independent layout bugs in this sheet, both
  measured in Chrome at 360 × 667 and both now guarded by
  `scripts/test-inspector-touch-controls.js`. *The scroll one:* switching
  category (or typing a search) replaces every card below the controls, and a
  scroller keeps its offset across that swap — clamped to the new list's maximum.
  With the **All** list read to its end (`scrollTop 2208/2208`), tapping **Type**
  left the body at `183/183`, i.e. scrolled to the end of the new six-card list,
  with the chip row at `top 63` against a body top of `156` — the new list and the
  chips you had just tapped were both out of view, so the sheet read as empty and
  changing category twice meant scrolling back up. The body now returns to
  `scrollTop 0` whenever the group or the query changes, because the search field
  and the chips live at the top of that scroller. *The ceiling one:* every sheet
  `max-height` was `dvh`-only. A browser that does not understand `dvh` (iOS
  Safari before 15.4, older WebViews) drops the declaration, leaving the sheet
  with no ceiling at all and sized by its content; with `align-items: flex-end` on
  the overlay that pushes the sheet's top **off screen**. Measured on this sheet
  with `dvh` dropped: 757 px tall in a 667 px viewport, top at `-90`, header and
  **Close** both off screen — hit-testing the Close button's centre returned
  `null`, and neither the space above nor below the sheet belonged to the overlay,
  so there was nothing left to tap to dismiss it. Each sheet now declares a `vh`
  fallback before its `dvh` value, the same pattern `base.css` uses on
  `html`/`body`, so the header and the way out survive an unsupported unit.
- **Ranges and steps** live in `RANGE_SPECS` (per property, side longhands
  resolving to their shorthand), and `specForValue` handles the one property whose
  authored and resolved forms disagree: `line-height` is written as a multiplier
  (`1.5`) but resolves to px (`62px`), so the px form gets a px span — otherwise
  the slider would sit pinned at its maximum and look alive while doing nothing. A slider's own resolution is its step as a
  percentage of the span, and `quantize` snaps to the step's own decimals so a
  drag cannot write `23.0000000000001px`.
- **Units** come from `unitOptions` in [`valueKinds.js`](../../frontend/src/components/inspector/valueKinds.js),
  the same conversion table the edit sheet's unit row uses, so a unit the panel
  cannot convert is disabled in both places with the same reason. `toUnit` falls
  back to px when a base size is missing rather than inventing one.
- **The panel passes `ctx: { declared, computed }`** — the same two lists its own
  rows render — plus `unitCtx` (the root/parent/self font sizes read with the
  element's styles) and `swatchesFor`, which maps a colour property to the values
  the page already uses through the panel's existing value index (no extra page
  read).
- **Mobile first.** Every interactive element is at least `--tap` (44 px) tall,
  and glyph-only controls are 44 × 44; each chip row wraps instead of scrolling
  sideways (a horizontal scroller inside the panel's vertical scroller hides its
  own content and drags the panel on a diagonal swipe); the slider keeps
  `touch-action: pan-y` so a vertical swipe still scrolls the list. The only
  width-based block relaxes spacing and pairs the cards above 560 px.
- **Tests.** `scripts/test-inspector-touch-controls.js` asserts the pure model
  (property names, reading order, maths, steps, unit conversion and its fallbacks,
  segment state including a value the list does not name, which controls apply to
  which element, box edges, the library search and its counts) plus the wiring and
  the CSS invariants: the 44 px floor per class, no horizontal scroller in the
  surface, and the panel handing the surface the lists it renders. Run it with
  `npm run test:inspector`.
- **The six bare quick-add chips are gone.** They were a fourth way into the same
  editor; the card sheet carries the same properties with a description, a picture
  and their current value. The dead CSS went with the markup in the same commit.

## Related

- [Inspector Styles panel](./inspector-styles.md) — the panel this surface lives in.
- [Inspector value types](./inspector-value-types.md) — how a value changes form.
- [Inspector value rail](./inspector-value-rail.md) — the editor sheet's numeric changer.
- [Inspector value suggestions](./inspector-value-suggestions.md) — the values the page already uses.
- [Inspector target-origin model](./inspector-target-origin.md) — where an edit lands.
- [Inspector](./inspector.md) — the host tab and its other panels.
