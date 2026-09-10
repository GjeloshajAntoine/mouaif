# Inspector Styles panel

## Overview

The **Styles** panel adds tap-to-select element inspection and touch-friendly CSS editing to the Inspector. Tap an element in the live preview (or type a selector), then edit its inline styles as a plain list of **property → value** rows that write straight to the page — and read the result in a pinned element preview, without scrolling back to the Preview panel.

## Usage

Open the **Inspector** tab, connect to a page, and turn on the **Styles** panel (its chip in the panel bar). Then:

1. **Tap to select** — tap **Tap element** to enter *pick mode*, then tap anywhere on the live preview. The matching element is highlighted (CDP `Overlay.highlightNode`) and its label (`div#hero.card`), box-size, inline styles, and computed styles appear.
   > Alternatively, type a CSS selector (e.g. `#hero .card`) in the small field and tap **Select**. This works even when the preview is hidden.
2. **Check the element** — a **pinned preview** of the selected element (a clipped screenshot) sits under the element header, as one sticky block at the top of the panel. It stays on screen while the property list below scrolls, so an edit's result is readable in place. Tap it to re-capture on demand (it is also re-captured automatically after every edit and when the selection changes).
3. **Edit a property** — tap any row in **Declared styles**, edit the property and value, then tap **Apply**. The change is written to the element's inline style (`element.style.setProperty`) and reflected immediately in the pinned preview. **Apply keeps the sheet open** so a value can be adjusted repeatedly; the close button reads **Cancel** until something has been applied, then **Done**. Tap **Remove** to drop a property.
4. **Nudge numbers** — for a numeric value (`24px`, `1.5`, `80%`) the value field is flanked by **− / +** steppers that apply immediately, which is the fastest way to size something on a phone. The steppers are disabled for non-numeric values (colors, keywords, shorthands).
5. **Add a property** — tap one of the quick chips (**color**, **background-color**, **font-size**, **margin**, **padding**, **border**) to open the editor pre-filled, or type any property name.
6. **Refresh** — the refresh button re-reads the element's styles after an external change; **Computed** shows the resolved values regardless of where they originate, so you can confirm an edit took effect even when a class or rule overrides it.
7. **Clear** — the ✕ button clears the selection, the pinned preview, and the page highlight.

## Behavior

- Edits land on the **element's inline style** only. This is the same origin the desktop Styles pane calls `element.style`; it is safest because it wins the cascade on the element and is fully reversible (tap **Remove**). Changing stylesheet rules (matched rules) needs `CSS.setStyleTexts` plus stylesheet source parsing and is out of scope for this pass.
- The property **must be non-empty** to apply or remove; the editor shows an inline error otherwise.
- The **pinned preview** is a region capture, not the full-page screenshot: the element is scrolled into view (centred), its box is measured, and `Page.captureScreenshot` is asked for a padded context window centred on it (520 × 360 CSS px, at most 2× device scale). A large element is therefore shown as a centred window rather than a whole-page smear scaled down to an unreadable size, and a small element is captured at near 1:1. An element with no layout (display:none, detached, zero-size) produces no preview rather than a broken image, and a failed capture leaves the previous preview in place instead of blanking the panel.
- The panel preview is a short **strip** (`object-fit: cover`, 56 px on a phone, 96 px in the grown panel on a wide screen) so it never crowds the property list; the edit sheet shows more of the element (120 px). The sticky block occupies ~115 px of the panel's 218 px scroller at 360 px wide, leaving ~4 property rows visible.
- Every row is a ≥ 44 px tap target (`--tap`). Editing opens a bottom sheet with large inputs, the element preview, and prominent **Apply / Remove** actions — no hover-only or tiny inline-text affordances. The panel-header icon buttons (clear ✕, refresh, pick-mode crosshair), the quick-add chips, the value steppers, and the panel's eye/refresh/full-screen/type controls all use the full 44 px `--tap` size so every control is a tappable target on a phone.
- The header icon buttons (clear ✕, refresh, pick/stop) are **labelled**, not glyph-only — each shows its word under the icon (`.icon-btn--labeled`). The labels are compact so the whole header — clear, element label + box size, and refresh/pick — stays on one line down to the 360 px minimum; the element label ellipsizes when the tag is long. The buttons keep `aria-label` + `title`. The pick button reads "Pick" off and "Stop" on.
- **Computed** values are read-only, monospace, and ellipsize. This is not a guard against invalid values — the browser normalizes what it accepts (CSSOM ignores anything the engine rejects).
- Pick mode turns the preview tap from "click the page" into "select an element". It is controlled by the Styles panel and reflected on the preview.

## Requirements

The **DOM** and **CSS** CDP domains must be enabled against the inspected target. The Inspector enables both on connect; if either is unavailable the panel shows "no element" rather than failing. The pinned preview additionally needs `Page.captureScreenshot` (already required by the Preview panel).

## Implementation notes

- **Files:** [`frontend/src/components/inspector/StylesPanel.jsx`](../../frontend/src/components/inspector/StylesPanel.jsx) (panel + edit sheet + pinned preview), [`frontend/src/components/inspector/events.js`](../../frontend/src/components/inspector/events.js) (CDP helpers), [`frontend/src/components/Inspector.jsx`](../../frontend/src/components/Inspector.jsx) (panel wiring + preview tap routing), [`frontend/src/inspector.css`](../../frontend/src/inspector.css) (styles).
- **CDP surface:** the helpers reuse the existing CDP proxy with no new server endpoints. `buildNodeModel` calls `DOM.describeNode`, `DOM.resolveNode`, `CSS.getComputedStyleForNode`, `DOM.getBoxModel`, and `Overlay.highlightNode`; `pickNodeAt` adds `DOM.getNodeForLocation`; `selectBySelector` adds `DOM.getDocument` + `DOM.querySelector`; edits use `Runtime.callFunctionOn` (`style.setProperty` / `style.removeProperty`). `captureElementShot` uses `Runtime.callFunctionOn` to centre + measure the element, then `Page.captureScreenshot` with a `clip`.
- **Capture serialization:** picks, applies, and manual refreshes can overlap, so `StylesPanel` keeps a `shotSerial` counter — only the newest capture may write to state, and a slow capture for a previously selected element can never replace the current element's preview.
- **Pick-mode tap routing:** `PreviewPanel` passes every tap to a wrapper that checks the parent's `stylesActive` flag. When on, the tap's screenshot coordinates go to the Styles panel's `pickFromPoint`; otherwise they fall through to `clickAt`. `viewportCoords` (extracted from `clickAt`) does the single screenshot→viewport coordinate mapping used by both paths.
- **Inspectable elements only:** picks resolve through the DOM domain, so text nodes and `::-webkit` pseudo parts are not selectable; tap the nearest real element.
- **Tests:** `npm run test:inspector` (or `scripts/test-inspector-styles.js`) verifies the CDP command sequence for tap-to-select, selector pick, inline-style edits, and the pinned element preview (padded context window, document-vs-viewport clip origin, no capture for a zero-size element).
## Related
- [Inspector](./inspector.md) — the host tab and its other panels.
- [Chrome Debug MCP](./chrome-debug-mcp.md) — automating the browser from the assistant.
