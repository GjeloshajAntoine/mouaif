// Inspector sheets — where every inspector overlay is mounted.
//
// Why this exists
// ---------------
// The inspector sheets (detail, confirm, add-property, profiles and the style
// editor) used to render where the panel that owns them renders. Two of them —
// the Add-property card sheet and the style editor — are owned by the Styles
// panel, which means they were mounted *inside* `.inspector__styles`: a nested
// scroll container (`overflow-y: auto` plus `-webkit-overflow-scrolling: touch`)
// that itself sits in the page's own scroller, `.app__main`.
//
// `position: fixed` normally escapes such an ancestor, and on the desktop build
// it does. On a phone it does not: when the scrolling ancestor becomes the
// overlay's containing block, `inset: 0` resolves against that ancestor's
// padding box, so the overlay is the size of the *scroller* and its content is
// clipped by the scroller's own overflow. Reproduced in Chrome by forcing the
// containing block the way WebKit hands it to a fixed descendant of a scroller
// (`.inspector__styles { transform: translateZ(0) }`) with the Add-property
// sheet open on a 393 x 852 phone viewport:
//
//   before — overlay 960 px tall (the viewport), sheet top 134, head 134…197,
//            `elementFromPoint` at Close's centre → `.inspector__sheet-close`;
//   after  — overlay 497 px tall (the scroller box, top -725), the 826 px sheet
//            aligned to its bottom put the head at top -1053, and
//            `elementFromPoint` at Close's centre → `null`.
//
// That is the reported bug in miniature: the sheet's header, its Close button
// and the search field / suggested chips at the top of its body were off screen
// and *unreachable*, because only the sheet body scrolls — the head cannot be
// scrolled back into view, and the backdrop covered only the panel body, so the
// rest of the app still looked interactive. "Can't go back or scroll all the
// way."
//
// The remedy
// ----------
// `createPortal(node, document.body)` mounts the overlay at the document root,
// outside every scrolling, transformed or clipped ancestor, so its `inset: 0`
// and `dvh` ceilings are measured against the viewport they are written for.
// This is the same remedy `DraftCraftAnnotator.jsx` uses for its own modal
// ("render the modal at the document root so the app dock cannot paint over
// it") and the same reason `ModelPickerField.jsx` puts its sheet in the native
// top layer with `showModal()`.
//
// The sheets keep their `.inspector__overlay` / `.inspector__sheet` classes:
// every rule for them is a plain class selector with no ancestor dependence
// (checked against `inspector-*.css`), so nothing about their look or their
// 44 px tap targets changes when they move to the root.
//
// Without a DOM (server render, a test that imports the module) the node is
// returned as-is, so the component still has something to render.
import { createPortal } from 'preact/compat';

export function sheetPortal(node) {
if (!node || typeof document === 'undefined' || !document.body) return node;
return createPortal(node, document.body);
}
