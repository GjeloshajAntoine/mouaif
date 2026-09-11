# Inspector value suggestions

## Overview

The type switch changes *how* a value is written and the unit cycle rewrites the same value in another unit — but neither answers the question that actually stalls an edit: **what should this value be?** The edit sheet therefore lists the values and design tokens **this page already uses** for the property being edited, each with the evidence behind it: how many times it appears and which rule supplies it.

## Usage

Open the edit sheet (tap a declared row or a quick-add chip). Below the value-type switch, for a property the page declares:

```
Value type — Length        [ Length 16px ][ Percent 100% ][ Number 16 ][ Keyword inherit ]
On this page · 3 values · steps of 4px
  [ 16px 3× ]  [ 12px 1× ]  [ 8px 1× ]
Tokens · from this page
  [ --space-4 = 16px ]  [ --space-3 = 12px ]
4 values on this page · steps of 4px
```

1. **On this page** — the values declared for this property anywhere in the page's stylesheets, most-used first. Each chip carries its count (`3×`) and, on its tooltip, the rule that supplies it (`used 3 times (.card)`) and its origin (`inherited from form.compare`).
2. **The value in force** — the one the element already resolves to is highlighted, not sorted away: picking it back is a legitimate way to undo a pending edit.
3. **Tokens** — custom properties (`--*`) whose value is valid for this property, shown as `--space-4 = 16px`. Picking one inserts the token **name**, so the declaration points at the design system rather than copying its value.
4. **The step** — when the page's values for the property share a numeric scale, the group header states it (`steps of 4px`) and the note under the chips repeats the evidence: `4 values on this page · steps of 4px`.
5. **Tapping a chip only rewrites the field.** Apply still commits, so a suggestion is exactly as reversible as anything typed — one property, one undo entry.

## Behaviour

- **The index is built from what the panel already reads** — the normalized matched rules and the computed style — so suggestions cost no extra CDP call. It is memoised because the panel re-renders on every CDP event (a console row, a network response) while those two inputs change only on a selection or an edit.
- **The count is evidence, not decoration.** `16px · 3×` says the design already uses this value three times, which is the difference between a guess and a choice. The rule name is on the tooltip because it is the answer to “where does that come from?”.
- **The selector recorded for a value is the rule that wins it**, because the cascade is already ordered most-specific first — the first rule seen declaring a value is the one supplying it.
- **A token is offered only when both checks pass**: its value classifies as a valid value for this property (the same classifier the type switch uses), *and* its name belongs to the property's family. The second check matters because `--radius-md` holds `8px` — a perfectly valid length — so a type check alone would offer a radius token as a `padding` value. Names are matched on segments (`--space-3` is space, `--radius-md` is radius, `--brand` is colour), and the check only ever *excludes*: an unknown property is type-checked rather than name-filtered.
- **An unresolved token is never offered.** A token declared as `var(--other)` is skipped until the computed style resolves it, because showing a token without knowing what it is worth is worse than showing nothing.
- **No suggestion for a property the page knows nothing about.** With neither a declared value nor a resolved value there is nothing to type tokens against, so the whole group is omitted rather than guessed.
- **The step is the GCD of the page's values** for the dominant unit: `4/8/12/16` reports `4px`, and `1.5/3/4.5` reports `1.5`. A single value has no step, and mixed units (a `50%` among `px` values) fall back to the unit used most rather than claiming one — and a shorthand value (`12px 10px 32px`) has no step at all, because it is not a number.
- **Chips stay on one line.** A long shorthand ellipsizes (its full text is on the tooltip and in the accessible name), so the row never wraps and the sheet never scrolls sideways.

## Implementation notes

- **Pure model:** [`frontend/src/components/inspector/valueIndex.js`](../../frontend/src/components/inspector/valueIndex.js) exports `buildValueIndex`, `valuesFor`, `tokensFor`, `scaleFor`, `scaleNote`, `numericScale`, `siblingValues`, `parseNumber`, `valueKey`, `tokenFamily`, `tokenFitsProperty`, `FAMILY_WORDS`, `PROPERTY_FAMILY` and the caps. `siblingValues` groups a caller's sibling read into “the 2nd section.input-section uses 16px”; the read itself is a later change.
- **Component:** [`frontend/src/components/inspector/Suggestions.jsx`](../../frontend/src/components/inspector/Suggestions.jsx) renders the two groups and the note; it emits nothing without an index, without a property, or when there is nothing to suggest. `StylesPanel.jsx` builds the index once per selection/edit and passes it into the sheet, whose `onPick` only rewrites its own value field.
- **Mobile-first:** every chip is a ≥44 px target with its evidence beside the value, the groups wrap, and the value span is capped so one long shorthand cannot widen the sheet.
- **Tests:** `npm run test:inspector` covers this with `scripts/test-inspector-value-index.js` (82 assertions): value counting with per-value selectors and counts, whitespace and case collapsing, the current-value marking, token typing and the name-family filter, the GCD scale including decimals and mixed units, number parsing, sibling grouping, the missing-declaration cases, and the component itself rendered in a stub (chips capped, evidence on the chip and in its accessible name, the value in force marked, token chips reporting the token name, and nothing emitted for an unknown property or a custom property).

## Related

- [Inspector value types](./inspector-value-types.md) — switching a value between length, number, percentage and keyword.
- [Inspector Styles panel](./inspector-styles.md) — tap-to-select, inline editing, matched rules.
- [Inspector non-destructive editing](./inspector-non-destructive-editing.md) — what an edit changes, what it keeps, and how to undo it.
