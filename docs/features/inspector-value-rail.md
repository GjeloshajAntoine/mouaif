# Inspector value rail

## Overview

The edit sheet's value field is the source of truth: it is where a value comes from, where a suggestion lands, and what **Apply** commits. What it is bad at is *choosing* a number on a phone — the range is invisible, the page's own steps are invisible, and trying `14px` instead of `16px` costs four taps on a keyboard. The **value rail** is therefore one numeric changer for every numeric kind: a track whose ticks are the values this page already uses, a thumb you drag, a precision segment, a unit chip, and the before → after readout in its header.

![The value rail in the edit sheet at 360 px](./images/inspector/value-rail-360.png)

## Usage

Open the edit sheet for a numeric property (tap a declared row, or a quick-add chip such as **padding**). The rail sits directly above the value field, under the page's own values and tokens.

1. **Drag the thumb.** The value field updates live; nothing is written to the page. Release, then **Apply** to commit — exactly like the type switch and the suggestion chips.
2. **Tap a tick.** The labelled round numbers (`0 20 40 60`) are buttons: one tap lands the value on that number. A violet tick is a design token, and tapping it writes the token's *value* (`--space-3 = 12px` → `12px`).
3. **Pick a step.** The precision segment offers `1 px`, `4 px`, `8 px` and `page`. `page` uses the step the value index derived for this property from the page's own values (`steps of 4px`), which is the same step the `−` / `+` buttons in the value row use.
4. **Cycle the unit.** The unit chip rewrites the same value in another unit (`px` ⇄ `rem` ⇄ `em`, `ms` ⇄ `s`, `deg` ⇄ `turn` ⇄ `rad`), using the page's real root font size rather than an assumed 16 px. A unit whose base size the inspector has not read is shown ticked-out.
5. **Read the header.** It states the kind, the value the property had before this session's first edit on it (struck through), the value now, and the step in force: `length 16px 44px page step 4px`.
6. **No rail is stated, not hidden.** A value with no numeric range (a keyword, a colour, `calc()`, an unparsable expression) renders `No rail: this value is not a number, so there is nothing to drag.` — the typed field stays the only control, which is the honest fallback rather than a disabled slider.
7. **The value being typed is placed on the page's scale.** When the field holds a value that is *not* one of the page's own, the rail draws the nearest on-scale value as a dashed ghost ring, and the suggestion row above it names the same value with a one-tap snap.

## Behaviour

- **The rail never writes to the page.** It only rewrites the sheet's value field, so a drag is one property and one undo receipt entry, and the element's other declarations are untouched. Verified live: after a full drag the inspected element's `style` attribute is still empty, and it changes only after **Apply**.
- **The rail never touches another property.** The only write path is the same `style.setProperty` the rest of the sheet uses, addressed at the property the sheet was opened for.
- **Ranges are per property family, not global.** `opacity` is 0…1, `line-height` 0…3, `z-index` −10…100, an angle −180…180 (0…360 for a hue), a time 0…2000 ms, a `scale()` 0…3, a percentage 0…200, and a length 0…4× the element's own size.
- **A length is measured against the right size.** A box property (`width`, `top`, `max-height`) is scaled by the element's box; a spacing, radius or type property is scaled by the element's font size, because a `16px` padding measured against a 448 px card would sit at 0.9% of the rail — technically "4× the size" and impossible to drag.
- **A logarithmic scale is used only where it helps.** A range whose maximum is at least 100× its minimum (`1px … 1000px`) is mapped logarithmically, which is the only case where a linear thumb spends most of its travel on values nobody wants. A range that starts at 0 is always linear, because a rail that cannot reach its own minimum is worse than a coarse one.
- **The value in force is always on the rail.** If the property's current value sits outside the family's usual bounds (`z-index: 400`), the range grows to include it rather than parking the thumb at an end and reading a different number than the page holds.
- **Ticks are capped so they stay ticks.** A 0…2000 ms range at a 10 ms step would be 200 marks ~1.7 px apart on a phone: the step is widened to the next multiple that fits 40 ticks, keeping the ticks on multiples of the page's step. A range with no page step gets ten evenly spaced ticks, which is the most the rail can show without implying precision it does not have.
- **Tokens are dropped rather than approximated.** A token outside the range, in another unit, or holding something that is not a number is not ticked — a violet mark at the wrong place is worse than no mark.
- **A drag never churns the field.** Writing the value the field already holds is a no-op, so a tap on the track cannot wipe a half-typed value.
- **The gesture is one pointer capture, no drag library.** The track is 60 px tall with `touch-action: none`, so the sheet's vertical scroller cannot claim a horizontal drag and the moves keep arriving after the finger leaves the track. Arrow keys work too (Left/Right, Down/Up), which costs nothing and makes the control usable with a keyboard.
- **Every control is a ≥44 px target**: the thumb is 34 px of ink inside the 60 px track, the tick labels carry 44 px hit areas without widening their marks, and the segment and unit chips are 44 px tall.
- **Nothing scrolls sideways.** The rail is 336 px inside the 360 px sheet, its labels are absolutely positioned inside the track, and the sheet body and the page both measure `scrollWidth − clientWidth = 0`.

## Implementation notes

- **Pure model:** [`frontend/src/components/inspector/valueRail.js`](../../frontend/src/components/inspector/valueRail.js) exports `railRange`, `familyOf`, `valueToRatio`, `ratioToValue`, `quantize`, `snapStep`, `nudge`, `tickValues`, `majorValues`, `railTicks`, `railLabel`, `railWritable`, `isLogRange`, `fromUnit`, `LOG_RATIO`, `MAX_TICKS` and `MAX_MAJOR`. It consumes the scale shape the value index already produces (`{ unit, values, step, decimals }`), so the rail costs no extra page read.
- **Component:** [`frontend/src/components/inspector/ValueRail.jsx`](../../frontend/src/components/inspector/ValueRail.jsx) exports `ValueRail`. It reads the property, the value, a context (`step`, `tokens`, `size`, `fontSize`, `rootFontSize`, `nearest`) and an `onChange`, and it renders the readout, the track, the ticks, the thumb and the footer.
- **Wiring:** `StylesPanel.jsx` assembles the context once per render (`scaleFor` for the step, `tokensFor` for the violet ticks, the element's box or font size for a length range, `snapValue`'s nearest value for the ghost) and passes `onChange` that only calls `setValue` — the same contract as `ValueTypes` and `Suggestions`, so `Apply` remains the single commit point.
- **Mobile-first:** the track is 60 px tall with a 34 px thumb, `touch-action: none` keeps the vertical gesture with the sheet, the labels are absolutely positioned so a long token name cannot widen the rail, and the footer wraps.
- **Tests:** `npm run test:inspector` covers this with `scripts/test-inspector-value-rail.js` (134 assertions): the per-family ranges, monotonicity and exact endpoints for every range, the log mapping and its geometric-mean midpoint, clamping in both directions, step selection and precedence, the nudge pair, tick generation with the cap, major-label rounding, token ticks (in range, out of range, wrong unit, unparsable, duplicated), label round-trips, the `railWritable` fallback reasons, the unit bases, and the mock's own rail end to end. Gesture handling is verified live, not unit-tested.

## Related

- [Inspector value suggestions](./inspector-value-suggestions.md) — the page's own values, the snap hint and the contrast badges.
- [Inspector value types](./inspector-value-types.md) — switching a value between length, number, percentage and keyword.
- [Inspector non-destructive editing](./inspector-non-destructive-editing.md) — what an edit changes, what it keeps, and how to undo it.
