# Inspector Styles panel

## Overview

The **Styles** panel adds tap-to-select element inspection and touch-friendly CSS editing to the Inspector. Tap an element in the live preview (or type a selector), then edit its inline styles as a plain list of **property → value** rows that write straight to the page — and read the result in a pinned, **live** element preview.

## Usage

Open the **Inspector** tab, connect to a page, and turn on the **Styles** panel (its chip in the panel bar). Then:

1. **Tap to select** — tap **Tap element** to enter *pick mode*, then tap anywhere on the live preview. A banner says **Pick: tap an element in the page** and the surface is outlined, so a tap that selects is never mistaken for a tap that pokes the page. The matched element is highlighted and its label (`div#hero.card`), box size, inline styles, and computed styles appear. Pick mode disarms itself after a successful pick; a miss keeps it armed, and **Cancel** (or the crosshair in the card header) turns it off.
   > You can also type a CSS selector (e.g. `#hero .card`) in the small field and tap **Select**. This works even when the preview is hidden.
2. **Check the element** — the selection's identity is the first row of the panel body: a full-width chip reading `div#hero.card` with its box size, which **taps to copy the selector**. The identity row is pinned, so it stays on screen while the list below scrolls. Under it sits the **element preview**, a live clipped screenshot of the element: it follows the page on its own, and it never blanks between captures. Tap it to force a re-capture; a caption reads *Live element preview — tap to refresh* and shows the capture's size.
3. **Walk the tree** — the **Element tree** section has two labelled rows:
   - **↑ Parents** — the path from the root to the selected element (`html › body › main#app › div.card`), on one sideways-scrolling line auto-scrolled to the current element. Tap any chip to move up. A `‹` marks a path that continues past the edge.
   - **↓ 3 children** — a disclosure whose text is the child count; tapping it opens one wrapped row of child chips. Tap a chip to move down.
   Ancestors are capped at 8 and children at 6 per read.
4. **Change it with touch controls** — the **Style controls** section edits the element with chips, sliders and swatches instead of typed values: six group tabs (**Layout**, **Spacing**, **Size**, **Text**, **Colour**, **Effects**), segmented chips for enumerated properties, sliders with **− / +** steppers and a **Fine / Coarse** step switch, a tappable box model, and colour rows offering colours the page already uses. It shows only the controls that apply to the element and writes the element's own inline style. See [Inspector touch controls](./inspector-touch-controls.md).
5. **Edit a property** — tap any row in **Declared styles**, edit the property and value, then tap **Apply**. A row opens with its current value, so an existing style is edited rather than retyped. **Apply keeps the sheet open**; the close button reads **Cancel** until something has been applied, then **Done**. Tap **Remove** to drop a property. A value the browser will not accept is named before you apply it, and **Cancel** with an unapplied edit asks before discarding it.
6. **Raise the priority when a rule keeps winning** — the sheet's **Priority** control reads **normal** or **!important**. A normal inline declaration does not beat a stylesheet rule marked `!important`; when a typed value appears to do nothing, set **!important** and apply again. A declared row stored `!important` shows an `!important` badge.
7. **Find what you changed** — every property edited in this session is highlighted with an accent bar and a `CHANGED` chip and hoisted to the top of both lists, most recent first. Values are re-read from the page after each edit. Picking a different element clears the highlight.
8. **Nudge numbers** — for a numeric value (`24px`, `1.5`, `80%`) the value field carries **− / +** steppers that apply immediately. The steppers are disabled for non-numeric values.
9. **Add a property** — tap **＋ Add property** to open the property browser inside the panel: search every property, narrow it by category, or tap a suggested chip. Picking a card opens the value editor on that property, pre-filled with the element's value when it declares one. The browser stays inline, so the element and its controls remain on screen.
10. **Refresh** — the refresh button in the card header re-reads the element's styles after an external change. **Computed** shows resolved values, so an edit can be confirmed even when something else overrides it. Refresh is disabled while a read is in flight or nothing is selected.
11. **Narrow the computed list** — **Computed** holds every property the browser resolves (~400 rows). Search property names *and* resolved values, then use **Show** — **All / Declared / Changed** — to switch between the full read-out, only what the element declares, and only what you edited. The line under the search states the filter in force in words (`Showing 12 of 406 · declared here`). Rows page in steps of 60; scrolling to the end pages the next step in on its own, and **Show N more** jumps ahead from anywhere. A page never ends in the middle of a property family, so `background-image` is never hidden while its siblings show.
12. **See where a value comes from** — **Matched rules** lists every rule that matches the element and its ancestors, most specific first, each with its selector, its `@media` condition, and its declaration count. Rules are collapsed to their header; tap one to open it, and tap a declaration to open the edit sheet pre-filled with that property and value. The section is collapsed by default and browser-default rules are filtered out behind a **Show N browser default rules** line.
13. **Clear** — the ✕ in the card header clears the selection, chip, preview, tree strips, and page highlight. Switching the panel off and on re-adopts the retained element; only an explicit ✕ drops it.

## Behavior

- Edits land on the **element's inline style** only (`element.style`). That wins the cascade on the element and is fully reversible with **Remove**. Changing the stylesheet itself is out of scope; **Matched rules** shows what a rule supplies and lets you override it on the element.
- A property **must be non-empty** to apply or remove, and an empty value is refused, because `setProperty(prop, '')` removes the declaration rather than doing nothing.
- A declaration the browser rejects is **reported, never silently dropped**. The sheet validates on every keystroke and disables **Apply**; the write is also read back and compared, because a shorthand (`padding: 30px`) is stored as its longhands and reading the typed name back returns nothing.
- Applying a shorthand may add **longhands** instead of the shorthand you typed (`margin: 40px` can appear as its four sides). Each longhand is listed and editable, and a shorthand edit highlights every declaration it wrote.
- **Changed properties come first** in both lists, with an accent bar and a `CHANGED` chip. The highlight is cleared when a different element is selected, kept across **Refresh**, and dropped when a property is removed.
- **The receipt is the way back.** Each session-receipt row reopens that property's editor on the value the page now has, and its ↺ button reverses the change. A removed property offers only the undo.
- **Only rows changed this session are tappable in Computed.** It is a read-only read-out of ~400 rows, so a tap target on every row would make the panel endless.
- The **pinned preview** is a region capture anchored at the element's own top-left, so a small element is captured near 1:1 and a large one is bounded rather than smeared. A live capture does not scroll the page; the manual paths centre the element first.
- The panel is **mobile-first**: every interactive row and control is at least a 44 × 44 px tap target, read-only rows are shorter, and nothing in the panel scrolls sideways. When Styles is the only visible panel it takes a taller body than the shared default.
- Pick mode can't complete while the **Preview** panel is hidden, so **Tap element** is disabled with a reason and the state points at the selector field instead.
- The empty state explains itself: what the panel is for, and — once pick mode is on — what to do next.

## Related

- [Inspector touch controls](./inspector-touch-controls.md) — the chips, sliders, box model and property browser this panel leads with.
- [Inspector value types](./inspector-value-types.md) — switching a value between length, number, percentage, and keyword.
- [Inspector](./inspector.md) — the host tab and its other panels.
- [Inspector target-origin model](./inspector-target-origin.md) — which element, which rule, and where an edit lands.
