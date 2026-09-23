# Inspector touch controls

## Overview

The **Style controls** section of the Inspector's Styles tab is a surface of
finger-sized widgets — segmented chips, sliders with − / + steppers, a tappable
box model, colour swatches and an **Add property** browser — for changing the
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
  that property, so "the same green as the rest of the page" is one tap. The
  swatch is painted over a checkerboard so a `transparent` value reads as
  "see-through" rather than as an empty control — the colour is set through
  `background-color` (an inline `background` shorthand would erase the
  checkerboard).
   - **Image rows** (background image) offer named gradient presets —
     **None / Down / Accent / Warm / Cool / Fade out** — because a gradient is
     thirty-odd characters of punctuation and typing one on a phone is the exact
     tax this surface exists to remove. The preset in force is highlighted; the
     value button opens the editor, where the image view lists the page's own
     gradients and images to copy.
4. **Type instead, when you want to** — the value on the right of every row is a
   button that opens the same editor a declared row opens: exact typing, the
   value-type switch, the unit row, the value rail and the page's own suggestions.
   A control never replaces it, and nothing here can express anything the editor
   cannot.
5. **Add a property** — **＋ Add property** opens the property browser *inside the
panel*, directly under the button: search every property, filter by category
(All / Layout / Spacing / Size / Type / Colour / Effects), or tap one of the
suggested chips. Each card draws a small picture of what the property does and
says **Choose**, or **Edit** with the value the element has now. Picking a card
opens the value editor on that property and closes the browser. It stays in the
panel — the pinned element preview and the controls you already set stay on
screen, because those are what each card is being compared against — and the
panel scrolls it, so the header (**Add a property** / **Close**) is always one
short scroll away. Since it is a disclosure rather than a new screen, the
**＋ Add property** button closes it again.
Switching category, or typing in the search field, brings the browser's own
controls — the search field and the chip row — back into view: both replace
every card below them, and they are what you need in view to choose again.
6. **Check and undo** — the receipt above the controls lists every change with the
value it replaced. Each row's ↺ restores it; **Undo all** reverses the session.
**Refresh** re-reads the element after an outside change, and **Clear** drops
the selection (and closes the property browser).

```text
Layout    display · position · (flex) direction, align items, justify, gap
Spacing   margin · padding box model
Size      width · height · corners
Text      font size · weight · line height · tracking · align · colour
Colour    background · background image · border colour
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
  the **Auto** / **100 %** chips, remain the paths. A gradient is the same
  honesty in another shape: there is no rail for it and there never will be, so
  the image row offers presets and hands the rest to the editor.
- **A preset is written in the form the browser reports it back.** The image row
  decides which preset is in force by comparing the element's value against the
  preset strings, and Chrome re-serialises what it stores — `#ffffff` comes back
  as `rgb(255, 255, 255)`, and a vertical `linear-gradient(180deg, …)` comes back
  without the `180deg`. Presets are therefore declared in Chrome's own output
  form (verified round-trip byte-identical on Chrome 140, and asserted in the
  test), so the chip lights up on the tap that set it instead of silently
  appearing to have done nothing.
- **Edits are reversible.** Nothing is written until a tap or a release, and every
  write is one receipt entry with the value it replaced.

## Related

- [Inspector Styles panel](./inspector-styles.md) — the panel this surface lives in.
- [Inspector value types](./inspector-value-types.md) — how a value changes form.
- [Inspector value rail](./inspector-value-rail.md) — the editor sheet's numeric changer.
- [Inspector value suggestions](./inspector-value-suggestions.md) — the values the page already uses.
- [Inspector target-origin model](./inspector-target-origin.md) — where an edit lands.
- [Inspector](./inspector.md) — the host tab and its other panels.
