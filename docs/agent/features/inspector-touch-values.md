# Inspector touch value editing — implementation notes

## Overview

The value editor extends beyond the six quick-control groups using reusable draft-only presets, scalar unit pickers and exact-span numeric-part replacement. User-facing behavior and limits are in [Inspector touch value editing](../../features/inspector-touch-values.md).

## Usage

Run `node scripts/test-inspector-touch-values.js` or `npm run test:inspector`. The test exercises pure choices/conversions and actual component callbacks, including a keyword-to-number start, rem conversion, preservation of colour/URL/variable content and relative-unit quick-control arithmetic.

## Implementation notes

- `frontend/src/components/inspector/touchValues.js` is pure: preset catalogue, scalar detection, unit choices/conversions and bounded numeric token extraction/replacement.
- `ValueUnitPicker.jsx` distinguishes explicit same-digits unit changes from conversions, filtering proposed writes through whole-declaration validation. Percentage, viewport and glyph bases are not assumed.
- `ValuePresets.jsx` labels starter values separately from the existing page-derived `Suggestions.jsx` and exposes expansion/search. It works without a value index.
- `NumericValueParts.jsx` edits up to 16 recognized numeric tokens with their source spans; strings, URLs, variables/env and colour functions are opaque. It changes the sheet's whole draft through the same callback, never CDP directly.
- `StylesPanel.jsx` centralizes draft changes in `onField`. `StyleValueEditor` is an in-flow region below the identity; no portal, modal, duplicate preview or body scroller. `openEditor` saves focus/scroll, `closeEditor` restores them, and the discard prompt is another in-flow group with reveal-on-open. Its derived hooks run before the empty-state return.
- The value field, unit chips, and suggestions come first. Property/type/priority/scope controls use a collapsed native details section; conversion is one labelled checkbox, and uncommon units use a separate disclosure.
- `test-inspector-inline-editor.js` guards the no-layer structure, ordering, navigation wiring and local palette (4.5:1 text, 3:1 control borders). Manual 360/430px checks also verified actual scroll/focus restoration and a visible discard prompt without an overlay.
- `ValueKindsView.jsx` no longer creates numeric rails for identifiers or colour/function arguments. Fan-out edits preserve each unlinked side's own unit.
- `StyleControls.jsx` passes measured font bases through `percentFor` and `nudgeValue`; `%` stays a native percentage rather than being silently rewritten as pixels. Unmeasured dimensions hand off to the value editor.
- `inspector-value-editor.css` imports after panel styles and before fullscreen overrides; new control targets are at least 2.75rem, wrap, and keep narrow-sheet overflow bounded.
- Manual Chromium harness checks at 360×667 and 430×896 verified no horizontal sheet overflow and no undersized new buttons/selects; a shadow's blur unit change preserved its rgba colour and made no write before Apply.
