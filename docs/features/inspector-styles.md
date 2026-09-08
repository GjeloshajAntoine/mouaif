# Inspector Styles panel
## Overview
The **Styles** panel adds tap-to-select element inspection and touch-friendly CSS editing to the Inspector. Tap an element in the live preview (or type a selector), then edit its inline styles as a plain list of **property → value** rows that write straight to the page — no desktop DevTools-style stylesheet parsing required.
## Usage
Open the **Inspector** tab, connect to a page, and turn on the **Styles** panel (its chip in the panel bar). Then:
1. **Tap to select** — tap **Tap element** to enter *pick mode*, then tap anywhere on the live preview. The matching element is highlighted (CDP `Overlay.highlightNode`) and its label (`div#hero.card`), box-size, inline styles, and computed styles appear.
   > Alternatively, type a CSS selector (e.g. `#hero .card`) in the small field and tap **Select**. This works even when the preview is hidden.
2. **Edit a property** — tap any row in **Declared styles**, edit the property and value, then tap **Apply**. The change is written to the element's inline style (`element.style.setProperty`) and reflected immediately. Tap **Remove** to drop a property, or **Cancel** to dismiss.
3. **Add a property** — tap one of the quick chips (**color**, **background-color**, **font-size**, **margin**, **padding**, **border**) to open the editor pre-filled, or type any property name.
4. **Refresh** — the refresh button re-reads the element's styles after an external change; **Computed** shows the resolved values regardless of where they originate, so you can confirm an edit took effect even when a class or rule overrides it.
5. **Clear** — the ✕ button clears the selection and removes the page highlight.
## Behavior
- Edits land on the **element's inline style** only. This is the same origin the desktop Styles pane calls `element.style`; it is safest because it wins the cascade on the element and is fully reversible (tap **Remove**). Changing stylesheet rules (matched rules) needs `CSS.setStyleTexts` plus stylesheet source parsing and is out of scope for this pass.
- The property **must be non-empty** to apply or remove; the editor shows an inline error otherwise.
- Every row is a ≥ 44 px tap target (`--tap`). Editing opens a bottom sheet with large inputs and prominent **Apply / Remove / Cancel** buttons — no hover-only or tiny inline-text affordances.
- **Computed** values are read-only, monospace, and ellipsize. This is not a guard against invalid values — the browser normalizes what it accepts (CSSOM ignores anything the engine rejects).
- Pick mode turns the preview tap from "click the page" into "select an element". It is controlled by the Styles panel and reflected on the preview.
## Requirements
The **DOM** and **CSS** CDP domains must be enabled against the inspected target. The Inspector enables both on connect; if either is unavailable the panel shows "no element" rather than failing.
## Implementation notes
- **Files:** [`frontend/src/components/inspector/StylesPanel.jsx`](../../frontend/src/components/inspector/StylesPanel.jsx) (panel + edit sheet), [`frontend/src/components/inspector/events.js`](../../frontend/src/components/inspector/events.js) (CDP helpers), [`frontend/src/components/Inspector.jsx`](../../frontend/src/components/Inspector.jsx) (panel wiring + preview tap routing), [`frontend/src/inspector.css`](../../frontend/src/inspector.css) (styles).
- **CDP surface:** the new helpers reuse the existing CDP proxy with no new server endpoints. `buildNodeModel` calls `DOM.describeNode`, `DOM.resolveNode`, `CSS.getComputedStyleForNode`, `DOM.getBoxModel`, and `Overlay.highlightNode`; `pickNodeAt` adds `DOM.getNodeForLocation`; `selectBySelector` adds `DOM.getDocument` + `DOM.querySelector`; edits use `Runtime.callFunctionOn` (`style.setProperty` / `style.removeProperty`).
- **Pick-mode tap routing:** `PreviewPanel` passes every tap to a wrapper that checks the parent's `stylesActive` flag. When on, the tap's screenshot coordinates go to the Styles panel's `pickFromPoint`; otherwise they fall through to `clickAt`. `viewportCoords` (extracted from `clickAt`) does the single screenshot→viewport coordinate mapping used by both paths.
- **Inspectable elements only:** picks resolve through the DOM domain, so text nodes and `::-webkit` pseudo parts are not selectable; tap the nearest real element.
- **Tests:** `npm run test:inspector` (or `scripts/test-inspector-styles.js`) verifies the CDP command sequence for tap-to-select, selector pick, and inline-style edits against a mock `cdpSend`.
## Related
- [Inspector](./inspector.md) — the host tab and its other panels.
- [Chrome Debug MCP](./chrome-debug-mcp.md) — automating the browser from the assistant.
