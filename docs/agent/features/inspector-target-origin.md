# Inspector target bar — implementation notes

> Agent-facing reference for [`docs/features/inspector-target-origin.md`](../../features/inspector-target-origin.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- **Pure model:** [`frontend/src/components/inspector/targetBar.js`](../../../frontend/src/components/inspector/targetBar.js) exports `buildTargetBar`, plus `splitLabel`, `buildCrumbs`, `crumbLabel`, `cleanSize`, `buildRuleChips`, `ruleCount`, `findDeclaringRule`, `inlineValueOf`, `pickFocusProperty`, `firstAuthorProperty`, `originSentence`, `WRITE_TARGETS` and the caps (`MAX_CRUMBS`, `MAX_RULE_CHIPS`, `CRUMB_MAX`). Nothing there touches the network or the DOM, so the ranking, the caps, the fallback order and the sentence wording are unit-testable.
- **Component:** [`frontend/src/components/inspector/TargetBar.jsx`](../../../frontend/src/components/inspector/TargetBar.jsx) is layout only — `Crumbs`, `RuleChips` and `TargetBar` render the model, and the header buttons are optional (a control with no handler is not rendered, rather than rendered dead).
- **Reused data, no new endpoints:** the label/size come from the existing `buildNodeModel`, the rules from `normalizeMatchedRules` (already used by the Styles panel's Matched rules section), the path from `readElementTree`, and the inline declarations from `readElementStyles`. The model adds no CDP call of its own.
- **Mobile-first:** every interactive element is a ≥44 px target (`--tap`), and the chips are text (not icon-only).
- **Tests:** `scripts/test-inspector-target-bar.js` still covers the model (the tag/id/class split, the crumb order and elision and truncation, the chip ranking, the declaration counts, the four origin-sentence cases, the focus-property fallback order, the scope numbers, and the component rendering). It runs as part of `npm run test:inspector`. `scripts/test-inspector-feature-inventory.js` pins that the Inspector no longer renders this bar above the panels and that the Styles panel still publishes its selection.
