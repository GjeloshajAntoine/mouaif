# Inspector value rail

## Overview

The edit sheet's value field is the source of truth, but it is poor at *choosing* a number on a phone: the range is invisible, the page's own steps are invisible, and trying `14px` instead of `16px` costs four taps on a keyboard. The **value rail** is one numeric changer for every numeric kind — a track whose ticks are the values this page already uses, a thumb you drag, a precision segment, a unit chip, and a before → after readout in its header.

![The value rail in the edit sheet at 360 px](./images/inspector/value-rail-360.png)

## Usage

Open the edit sheet for a numeric property (tap a declared row, or a quick-add chip such as **padding**). The rail sits directly above the value field, under the page's own values and tokens.

1. **Drag the thumb.** The value field updates live; nothing is written to the page. Release, then **Apply** to commit — exactly like the type switch and the suggestion chips.
   - **Drag normally for whole steps, slowly for fine.** The coarse step is what makes the gesture usable; a slow drag drops to the family's finest step so 13 px and 14 px are both reachable. The header says `fine 1px` while it is in force.
   - **Double-tap the track for the keypad.** One tap writes the value under the finger; a second tap in the same place focuses the typed field, because "nearly 14 px" is the moment exact typing is the next move.
   - **Tap-hold a tick to lock to it.** A 500 ms press writes the tick's value and marks the tick, and the header reads `locked · --space-3`. The next gesture releases it.
2. **Tap a tick.** The labelled round numbers (`0 20 40 60`) are buttons. A violet tick is a design token, and tapping it writes the token's value (`--space-3 = 12px` → `12px`). A green tick is a **fraction of this element** — `¼`, `½` or `1` of its own size — and tapping it writes that number.
3. **Pick a step.** The precision segment offers three steps for this value's kind — `1 px` / `4 px` / `8 px` for a length, `0.01` / `0.05` / `0.1` for an opacity, `10 ms` / `50 ms` / `100 ms` for a duration — plus `page`, which uses the step the page's own values imply. The header says which step is in force and where it came from (`page step 4px`).
4. **Cycle the unit.** The unit chip rewrites the same value in another unit (`px` ⇄ `rem` ⇄ `em`, `ms` ⇄ `s`, `deg` ⇄ `turn` ⇄ `rad`), using the page's real root font size. The footer prints the conversion before you spend the tap: `px = 0.875rem`.
5. **Read the header.** It states the kind, the value the property had before this session's first edit on it (struck through), the value now, and the step in force: `length 16px 44px page step 4px`.
6. **No rail is stated, not hidden.** A value with no numeric range (a keyword, a colour, `calc()`) renders `No rail: this value is not a number, so there is nothing to drag.`, and the typed field stays the only control.
7. **Leaving the scale is one tap, and so is coming back.** A value off the page's scale draws a dashed ghost ring at the nearest on-scale value; the footer then offers **leave scale**, which keeps the value and switches the drag to the family's finest step. **use scale** puts the page's step and the ring back.
8. **A typed value is placed on the page's scale.** When the field holds a value that is not one of the page's own, the rail draws the nearest on-scale value as a ghost ring and the suggestion row names the same value with a one-tap snap.

## One view per kind

The rail is right for *a* number and wrong for a colour (three numbers that only mean something together), a four-sided shorthand (four numbers that are one declaration), a function list, and an enum. The sheet picks a view per kind from the value the property holds when it opens, and holds it for as long as the sheet is open:

| Kind | View | Properties |
| --- | --- | --- |
| Length, number, percent, `scale()`, custom property holding a number | The rail | `padding: 14px`, `opacity: 0.5`, `--space-card: 14px` |
| Colour | Three rails (hue / saturation / lightness), the page's palette with per-swatch contrast badges, hex / rgb / hsl / `color-mix()` format chips | `color`, `background-color`, `border-color` |
| Fan-out | One sub-rail per side plus a "link all sides" switch | `padding`, `margin`, `inset`, `border-width`, `border-radius`, `gap` |
| Enum | Segmented keyword chips, the page's own values first and the CSS-wide keywords last | `display`, `position`, `overflow`, `text-align`, `flex-direction` |
| Functions | One rail per argument, or one row per item for a comma list | `transform`, `filter`, `box-shadow`, `transition`, `animation` |
| Image | The page's own images and gradients as candidates — no rail | `background-image`, `mask-image` |
| Time / Angle | The rail plus its unit segment | `transition-duration`, `animation-delay`, `rotate`, `hue-rotate` |
| Anything else | The typed field, with a note saying why there is no view | `font-family`, `content`, `calc()`, `var()` |

A colour gets three rails because each track can then be a picture of the value. A fan-out shows what will be written under the sub-rails, with **link all sides** starting on for a shorthand that is already uniform. A function list gets one rail per argument plus `▲` / `▼` / `✕` and an **Add** row — reorder is part of the value, because a transform list is not commutative. An enum appears only for a property with two or more of its own keywords. An image view offers the page's own `url()` and gradient values instead of a rail. See [Inspector value types](./inspector-value-types.md) for switching between kinds.

![The padding fan-out with four sub-rails at 360 px](./images/inspector/value-fanout-360.png)

## Behaviour

- **The rail never writes to the page.** It only rewrites the sheet's value field, so a drag is one property and one undo receipt entry, and the element's other declarations are untouched. The write path is the same `style.setProperty` the rest of the sheet uses.
- **Ranges are per property family, not global.** `opacity` is 0…1, `line-height` 0…3, `z-index` −10…100, an angle −180…180 (0…360 for a hue), a time 0…2000 ms, a `scale()` 0…3, a percentage 0…200, and a length 0…4× the element's own size.
- **A length is measured against the right size.** A box property (`width`, `top`, `max-height`) is scaled by the element's box; a spacing, radius, or type property is scaled by the element's font size.
- **The value in force is always on the rail.** If the current value sits outside the family's usual bounds (`z-index: 400`), the range grows to include it rather than parking the thumb at an end.
- **Three tick families, three jobs.** A grey tick is a step, a dark tick is a tappable round number, a violet tick is a design token, and a green tick is a share of this element. A token that is off-scale, in another unit, or not a number is dropped rather than approximated.
- **A drag never churns the field.** Writing the value the field already holds is a no-op, so a tap on the track cannot wipe a half-typed value.
- **The gesture is one pointer capture, no drag library.** The track is 60 px tall with `touch-action: none`, so the sheet's vertical scroller cannot claim the drag. Arrow keys work too.
- **Every control is a ≥44 px target**, and nothing in the rail scrolls sideways.

## Related

- [Inspector value suggestions](./inspector-value-suggestions.md) — the page's own values, the snap hint and the contrast badges.
- [Inspector value types](./inspector-value-types.md) — switching a value between length, number, percentage and keyword.
- [Inspector non-destructive editing](./inspector-non-destructive-editing.md) — what an edit changes, what it keeps, and how to undo it.
- [Inspector Styles](./inspector-styles.md) — the panel the sheet belongs to.
