# Inspector touch value editing

## Overview

Every Styles row opens the same value editor, including rows outside the six Style controls groups. The editor offers common-value suggestions, explicit unit selection, and individual numeric-part controls for compound CSS, alongside the values and tokens already found on the page.

## Usage

1. Select an element in **Inspector → Styles**, then tap a Declared, Computed, or Matched rules value.
2. Use **Suggested values** for common values and keywords. Grid tracks, ratios, fonts, borders, shadows, images, transforms and transitions have starter presets; numeric families offer numeric presets. **Show all** expands the list and adds search. These are examples, clearly separate from **On this page** suggestions.
3. Use **Choose unit** to keep the number and deliberately change its unit. For example, `16px` becomes `16rem`, **not** `1rem`. With `auto` or an empty length value, choosing a unit starts at zero. Common units have chips; **All units** also offers physical and viewport units. Units that are invalid for the whole declaration are disabled.
4. Use **Convert unit** to preserve the value when its basis is known: `16px` becomes `1rem` with a 16px root. Unmeasured percentage, viewport or glyph-based conversions are disabled with a reason; switch back to Choose unit if a new value, rather than a conversion, is intended.
5. For a compound value, use **Numeric parts**. Each recognized number has − / +, a numeric input, and its own unit picker. Changing one part preserves everything around it:

```css
/* Change only the blur length; the colour is preserved. */
box-shadow: 0px 2px 8px rgba(0, 0, 0, 0.2);
box-shadow: 0px 2px 1rem rgba(0, 0, 0, 0.2);
```

6. Tap **Apply** to commit. Suggestions, unit changes and part controls only change the draft; Cancel asks before discarding a valid pending touch edit, just as it does for typed edits.

## Limitations

- CSS has an open-ended value grammar. Arbitrary strings, image URLs, identifiers and unsupported functions still have an exact text field; they do not get invented numeric controls.
- Strings, URLs, variables (including fallbacks), environment variables and colour functions are opaque to Numeric parts. Hex colours and identifier digits are not treated as dimensions. Colour editing continues to use the colour view.
- Numeric parts are capped at 16 per value. Complex values remain completely visible/editable in the text field.
- Unit choices and presets are checked with the UI browser's `CSS.supports`; the existing inspected-page write validation remains authoritative. Different browser capabilities can still cause an Apply error.
- Percentage, viewport and glyph conversions require bases not currently measured. They can be chosen explicitly, but are not presented as lossless conversions.

## Behavior

- Function/list rails only render for true numeric arguments, never for colour functions or identifiers. Mixed-unit fan-out sides keep their own unit unless Link all is explicitly used.
- Relative-unit Style controls use measured font sizes for sliders and steppers, so nudging a rem value preserves its unit.
- Controls wrap, use at least 44 × 44px targets, and remain inside the existing safe-area-aware bottom sheet.
- No new server endpoint or dependency is required.

## Related

- [Inspector Styles](./inspector-styles.md)
- [Inspector touch controls](./inspector-touch-controls.md)
- [Inspector value types](./inspector-value-types.md)
- [Inspector value suggestions](./inspector-value-suggestions.md)
