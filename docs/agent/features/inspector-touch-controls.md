# Inspector touch controls — implementation notes

> Agent-facing reference for [`docs/features/inspector-touch-controls.md`](../../features/inspector-touch-controls.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- **Files.** [`frontend/src/components/inspector/styleControls.js`](../../../frontend/src/components/inspector/styleControls.js)
is the pure model — the control catalog, the range specs, value parsing, the
step/percent maths, the unit conversions, the box-model edges and the
add-property library (no Preact, no DOM, no CDP).
[`frontend/src/components/inspector/StyleControls.jsx`](../../../frontend/src/components/inspector/StyleControls.jsx)
renders it;
[`frontend/src/components/inspector/AddPropertyBrowser.jsx`](../../../frontend/src/components/inspector/AddPropertyBrowser.jsx)
is the property browser — a section of the Styles card, not a sheet;
[`frontend/src/inspector-touch.css`](../../../frontend/src/inspector-touch.css) is
the styling, imported by `frontend/src/inspector.css`.
- **The property browser is a section of the panel, not a sheet.** It began as a
bottom sheet (`.inspector__sheet--addprop`, an 86 dvh overlay with a backdrop),
and that was wrong twice over. It covered the element the cards are *about*: the
pinned preview, the identity row and the controls already set are the context for
every card, and a viewport-sized sheet with a scrim put all of it behind the
question. And, rendered inside `.inspector__styles` — a scroller nested in the
page's own scroller — a sheet could be laid out and clipped against that scroller
instead of the viewport, which put its head, its **Close** and its search field
off screen and out of reach (measured at 393 × 852 with the containing block
forced: overlay 497 px tall instead of 960, head at `top -1053`,
`elementFromPoint` at **Close** → `null`). Both are answered by rendering the
cards as a normal block between **Style controls** and **Declared styles**,
directly under the **＋ Add property** button: the panel's own scroller is the
only scroller, nothing is fixed or clipped, and the trigger is a disclosure
(`aria-expanded` + `aria-controls="inspector-addprop"`) so the same tap closes the
list again. The five remaining overlays — the style editor, the detail sheet, the
confirm sheet and the Chrome profiles sheet — are portalled to `document.body`
(see [Inspector Styles panel](../../features/inspector-styles.md) and the implementation notes).
- **The card picture is `inspector__propcard`, not `inspector__preview`.** The
card thumbnail was originally `.inspector__preview` — the name the
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
- **Switching category or search brings the browser's own controls back into
view.** Switching group (or typing a search) replaces every card below the
controls, and the panel's scroller keeps its offset across that swap — clamped to
the new list's maximum. With the **All** list read to its end (measured in the
sheet this replaced, at 360 × 667: `scrollTop 2208/2208`), tapping **Type** left
the list `183/183`, i.e. scrolled to the end of the new six-card list, with the
chip row 93 px above the visible region: the new list and the chips just tapped
were both out of view, so the surface read as empty and changing category twice
meant scrolling back up first. The browser now asks the *panel* to bring its head
— search field first, chip row under it — into view whenever the group or the
query changes, and when it opens, through the same `revealInPanel` helper the
group chip row uses, so the panel's sticky identity/preview block is measured and
never overlapped. Re-measured after the change at 375 px: switching from the end
of **All** (`scrollTop 4248`) to **Layout** landed at `1443` with the head, the
search field and the chip row all hit-testing to themselves.
- **The `vh` → `dvh` ceilings still matter for the remaining sheets.** Every
sheet `max-height` that is `dvh`-only loses its ceiling on a browser that does not
understand `dvh` (iOS Safari before 15.4, older WebViews) and is then sized by its
content; with `align-items: flex-end` on the overlay that pushes the sheet's top
**off screen**. Measured on the old Add-property sheet with `dvh` dropped: 757 px
tall in a 667 px viewport, top at `-90`, header and **Close** both off screen —
hit-testing **Close**'s centre returned `null`, and neither the space above nor
below the sheet belonged to the overlay, so there was nothing left to tap to
dismiss it. Every sheet that is still an overlay declares a `vh` fallback before
its `dvh` value, the same pattern `base.css` uses on `html`/`body`. The
Add-property browser has no ceiling to get wrong: it is a block in the panel.

- **Every sheet that is still an overlay is mounted at the document root.** The
style editor is owned by the Styles panel, so it used to be mounted *inside*
`.inspector__styles` — a scroll container (`overflow-y: auto`) nested in the page's
own scroller — and the detail / confirm / profiles sheets inside the (also
scrollable) panel stack. `position: fixed` normally escapes an ancestor like that,
but where the scrolling ancestor becomes the overlay's containing block, `inset: 0`
resolves against the scroller's box and the overlay is clipped by that scroller's
overflow, so the sheet's own header and **Close** were off screen and unreachable
— only the body scrolls, and the backdrop covered just the panel body, so the rest
of the app still looked live. Reproduced on a 393 × 852 viewport by forcing the
containing block the way a phone hands it to a fixed descendant of a scroller
(`.inspector__styles { transform: translateZ(0) }`): the overlay went from
960 px (the viewport) to 497 px (the scroller box, top `-725`), and the 826 px
sheet anchored to its bottom put the header at `top -1053` with
`elementFromPoint` at **Close**'s centre returning `null`. Each such sheet now
returns `sheetPortal(node)`
(`frontend/src/components/inspector/sheetPortal.js`), which is
`createPortal(node, document.body)` with a no-DOM guard — the same root
mounting `DraftCraftAnnotator.jsx` uses for its modal — so the overlay, its
backdrop and its `dvh` ceilings are measured against the viewport again.
`scripts/test-inspector-touch-controls.js` asserts that every file rendering an
`.inspector__overlay` imports the helper and portals **every** overlay it
renders, and — the other way round — that the Add-property cards render **no**
overlay and no portal, because they are a section of the panel.
- **Ranges and steps** live in `RANGE_SPECS` (per property, side longhands
  resolving to their shorthand), and `specForValue` handles the one property whose
  authored and resolved forms disagree: `line-height` is written as a multiplier
  (`1.5`) but resolves to px (`62px`), so the px form gets a px span — otherwise
  the slider would sit pinned at its maximum and look alive while doing nothing. A slider's own resolution is its step as a
  percentage of the span, and `quantize` snaps to the step's own decimals so a
  drag cannot write `23.0000000000001px`.
- **Units** come from `unitOptions` in [`valueKinds.js`](../../../frontend/src/components/inspector/valueKinds.js),
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
  editor; the property browser carries the same properties with a description, a
  picture and their current value. The dead CSS went with the markup in the same
  commit.
