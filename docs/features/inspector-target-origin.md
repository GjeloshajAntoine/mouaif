# Inspector target bar

## Overview

The **target bar** no longer renders above the Inspector's panels. On a phone it read as a second navigation block that was not one of the app tabs (Chats / Inspector / Settings), it could not be dismissed, and it duplicated answers the Styles panel already gives. The three answers it existed for — *which element* is selected, *which rule* a value comes from, and *where the edit lands* — now live inside the Styles panel: its sticky element header, its **Element tree** section, its **Matched rules** section (which marks `element.style` as the write target) and its **Receipt** strip.

`targetBar.js` (pure model) and `TargetBar.jsx` (layout) are kept, and `selectionAcrossModes` from that module is still used by the Intent surface, which needs a selection that survives the Styles panel being switched off.

The rest of this page documents that model: it is still the reference for how the Styles panel decides *which property* it describes and *where* an edit lands.

## Usage

Connect to a page and select an element (tap the preview in pick mode, tap **Tap element**, or type a selector in the Styles panel). The Styles panel then shows:

1. **Element header** — the element in DevTools notation (`div#standalone-api-panel.standalone-api-panel`) with its box size. The size is dropped when the box could not be measured, so a meaningless `— × —` is never printed.
2. **Matched rules** — the rules that match, best answer first: `element.style` (marked as the write target), then author rules on the element, then inherited rules. Each chip carries its declaration count. Browser-default rules are **filtered out by default** — their “selector” for a `div` is the whole HTML element list, which would wrap the row to five lines on a phone; the section lists them on request through its own **Show 5 browser default rules** control (the rules themselves are chipped **browser**).
3. **Element tree** — the path to the element (`html › body › div#standalone-api-panel`), current element highlighted, plus one tap to any ancestor and a collapsible child list. Ancestor and child taps use the same code path as the panel's own selection, so the highlight, the pinned element preview and the changed-set reset all stay in sync.
4. **Origin sentence** — one line explaining where the focused value comes from and what editing will do, e.g.
   - `padding: 16px is set on element.style, which wins this value for this element only.`
   - `padding comes from the stylesheet rule .card (16px). Editing element.style overrides it for this element only.`
   - `gap comes from an inherited rule on form.compare. Editing element.style overrides it for this element only.`
   - `--bg-app is set on the ancestor html (its inline style) and inherits down (#f4f7fb). Editing element.style overrides it for this element only.`
5. **Header controls** — **✕ Clear**, **↻ Refresh** and **◎ Pick** live in the Styles panel's sticky header.


## Behaviour

- **Which property is described** follows the user's attention: the property being edited, else the most recent change this session, else the element's first own declaration, else the first declaration of the best-ranked author rule. That last fallback matters: an element with no inline styles is the common case, and without it the panel would have nothing to explain exactly when the question is “where do this element's values come from?”. Browser-default declarations are never chosen.
- **The retained selection survives a mode switch.** The Inspector keeps the last non-empty selection the panel published (`selectionAcrossModes` in `targetBar.js`). Nothing in the Inspector chrome renders it any more, but the Intent surface reads it, and the panel re-adopts the retained element by `objectId` when it comes back (`restoreObjectId`), so switching panels off and on again does not lose the element.
- **The write target is inline only, and the panel says so.** `element.style` wins the cascade on the element and is fully reversible, so every edit from this panel goes there. Editing a stylesheet rule needs `CSS.setStyleTexts` plus stylesheet source parsing; `WRITE_TARGETS` in `targetBar.js` lists that target as *not enabled yet* rather than leaving its absence unexplained.
- **The selection stays owned by the Styles panel.** The panel publishes a snapshot (`onSelectionChange`) after each selection or cascade read, and publishes its own actions through one handle ref (`panelHandlesRef`: `selectAncestor`, `clear`, `refresh`). It clears that snapshot on unmount, and the Inspector retains the last non-empty one, which is what the Intent surface and `restoreObjectId` read.
- **Undo lives in the Styles panel.** The receipt strip and its **↺ Undo all** render inside that panel's own scroll flow (see [Inspector styles](./inspector-styles.md)). The Inspector still owns the receipt data, so switching the panel off cannot drop it, and reversing an entry re-reads the element afterwards.
- **Tapping a rule chip reveals the cascade** rather than pretending the chip is an editor: the Styles panel's **Matched rules** section is where a rule's declarations and the one-tap override live, so the chip makes sure that panel is visible.
- **No horizontal scrolling.** The breadcrumb and the child chips wrap (a horizontal scroller inside a vertical page steals the vertical gesture); the panel keeps the only vertical scroller.

## Implementation notes

- **Pure model:** [`frontend/src/components/inspector/targetBar.js`](../../frontend/src/components/inspector/targetBar.js) exports `buildTargetBar`, plus `splitLabel`, `buildCrumbs`, `crumbLabel`, `cleanSize`, `buildRuleChips`, `ruleCount`, `findDeclaringRule`, `inlineValueOf`, `pickFocusProperty`, `firstAuthorProperty`, `originSentence`, `WRITE_TARGETS` and the caps (`MAX_CRUMBS`, `MAX_RULE_CHIPS`, `CRUMB_MAX`). Nothing there touches the network or the DOM, so the ranking, the caps, the fallback order and the sentence wording are unit-testable.
- **Component:** [`frontend/src/components/inspector/TargetBar.jsx`](../../frontend/src/components/inspector/TargetBar.jsx) is layout only — `Crumbs`, `RuleChips` and `TargetBar` render the model, and the header buttons are optional (a control with no handler is not rendered, rather than rendered dead).
- **Reused data, no new endpoints:** the label/size come from the existing `buildNodeModel`, the rules from `normalizeMatchedRules` (already used by the Styles panel's Matched rules section), the path from `readElementTree`, and the inline declarations from `readElementStyles`. The model adds no CDP call of its own.
- **Mobile-first:** every interactive element is a ≥44 px target (`--tap`), and the chips are text (not icon-only).
- **Tests:** `scripts/test-inspector-target-bar.js` still covers the model (the tag/id/class split, the crumb order and elision and truncation, the chip ranking, the declaration counts, the four origin-sentence cases, the focus-property fallback order, the scope numbers, and the component rendering). It runs as part of `npm run test:inspector`. `scripts/test-inspector-feature-inventory.js` pins that the Inspector no longer renders this bar above the panels and that the Styles panel still publishes its selection.

## Related

- [Inspector](./inspector.md) — the host tab and its other panels.
- [Inspector Styles panel](./inspector-styles.md) — tap-to-select, inline editing, the element tree, matched rules and computed values.
- [Inspector value suggestions](./inspector-value-suggestions.md) — the values and tokens the page already uses, with counts and origins.
