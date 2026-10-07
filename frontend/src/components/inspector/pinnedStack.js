// pinnedStack — the sticky strips at the top of the Styles panel.
//
// The panel has three things that must stay reachable while the rows below
// scroll, and they are not the same kind of thing:
//
//   1. the **identity row** (`.inspector__styles-pin`) — `tag#id.class` plus the
//      box size, which answers "what am I editing?" and stays put for the whole
//      panel;
//   2. the **section rail** (`.inspector__styles-jump`) — Controls / Declared /
//      Rules / Computed, the only index of a scroller that is ~3300 px tall on
//      a phone; and
//   3. the **group chip row** (`.inspector__touch-tabs`) — the only index of the
//      touch surface, which is only read once the user is *inside* a group's
//      cards.
//
// All three are `position: sticky` against the panel's own scroller, and each
// has to pin *directly below* the one above it rather than on top of it. That is
// a number CSS cannot know: the identity row's height follows its content — an
// error line appears under it when a tree hop fails, and the label ellipsizes or
// wraps with the element's own `tag#id.class` — and the rail re-wraps to two
// rows on a very narrow viewport. A hard-coded offset therefore drifts the
// moment a strip changes, and the drift is invisible until two strips overlap
// again.
//
// So each strip's height is measured and published as a custom property, and
// every offset below it is written in terms of those (see the stylesheets):
//
//   .inspector__styles-pin  { top: -6px; }                       /* panel padding */
//   .inspector__styles-jump { top: calc(var(--insp-pin-h, 44px) - 6px); }
//   .inspector__touch-tabs  { top: calc(var(--insp-pin-h, 44px)
//                                       + var(--insp-rail-h, 53px) - 6px); }
//
// The `-6px` is the panel's top padding, which the pin cancels with its own
// negative `top` so the row sits flush against the panel's border; the strips
// below pin into the same scrollport, so they subtract the same 6 px.
//
// Everything here is a pure function over a duck-typed node (something with
// `getBoundingClientRect` for measurement and `style.setProperty` for the
// write), which is what makes the arithmetic testable without a browser.

// The custom property each strip's height is published under. Read by
// `inspector-touch.css` / `inspector-styles.css`; written by
// `applyPinHeight` / `applyRailHeight`.
export const PIN_HEIGHT_VAR = '--insp-pin-h';
export const RAIL_HEIGHT_VAR = '--insp-rail-h';

// What the strips below fall back to before the first measurement: one `--tap`
// row for the identity row (the height a pin with no error line has) and one
// `--tap` row plus the rail's own padding and border for the rail. The
// measurement is applied from a layout effect (see StylesPanel), so these values
// are only in force if the panel renders somewhere the effect cannot run; a
// wrong-for-one-frame offset would otherwise leave the strips a few px inside
// each other.
export const PIN_HEIGHT_FALLBACK = '44px';
export const RAIL_HEIGHT_FALLBACK = '53px';

// pinHeightPx — a strip's measured height as a whole-pixel CSS length, or `''`
// when nothing can be measured. Rounded (not fractional) because the value is
// compared against `getBoundingClientRect()` edges in the reveal maths, and a
// sub-pixel offset there shows up as a strip that is 1 px out of place.
//
// A detached or hidden node reports `0`: that is "no measurement", not "a strip
// of height zero", so it returns `''` and the caller leaves the property alone
// rather than pinning the strip below it to the top of the panel.
export function pinHeightPx(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return '';
  const box = node.getBoundingClientRect();
  const height = box && box.height;
  if (typeof height !== 'number' || !isFinite(height) || height <= 0) return '';
  return Math.round(height) + 'px';
}

// applyPinHeight — publish one strip's height to `root` (the panel element, so
// every sticky row inside it can read the property). Returns the value written,
// or `''` when there was nothing to measure and the property was cleared.
//
// It writes to `style` rather than to a class because the value changes as the
// user works (a failing hop adds an error line, a narrow viewport re-wraps the
// rail), and an inline custom property is the one place a measurement can live
// without a stylesheet per height.
//
// `name` defaults to the identity row's property, so the existing callers and
// tests keep working; the rail passes its own.
export function applyPinHeight(root, node, name) {
  const property = name || PIN_HEIGHT_VAR;
  if (!root || !root.style || typeof root.style.setProperty !== 'function') return '';
  const px = pinHeightPx(node);
  if (!px) {
    if (typeof root.style.removeProperty === 'function') root.style.removeProperty(property);
    return '';
  }
  if (root.style.getPropertyValue && root.style.getPropertyValue(property) === px) return px;
  root.style.setProperty(property, px);
  return px;
}

// applyRailHeight — the section rail's own height, published under
// `RAIL_HEIGHT_VAR`. Same contract as applyPinHeight, kept as its own name
// because the two strips are measured from different nodes and the reader of
// each property (the rail's own `top`, the chip row's `top`) is different.
export function applyRailHeight(root, node) {
  return applyPinHeight(root, node, RAIL_HEIGHT_VAR);
}

// watchPin — measure now, and again whenever the strip's own box changes, then
// return a stop function for the effect's cleanup.
//
// The observer is what keeps the strips in step in the cases the panel does
// not render for: a font that finishes loading and re-wraps the label, a
// rotation that changes how many lines `tag#id.class` takes, a viewport narrow
// enough that the rail wraps to a second row, a zoom. It is deliberately *not*
// the only measurement — `apply` runs immediately, so a target without
// `ResizeObserver` (an older WebView) still gets a correct offset instead of the
// fallback.
export function watchPin(node, apply, options) {
  const opts = options || {};
  const RO = opts.ResizeObserver !== undefined
    ? opts.ResizeObserver
    : (typeof ResizeObserver === 'function' ? ResizeObserver : null);
  if (typeof apply === 'function') apply();
  if (!node || !RO) return () => {};
  const observer = new RO(() => { if (typeof apply === 'function') apply(); });
  observer.observe(node);
  return () => {
    try { observer.disconnect(); } catch (err) { /* nothing left to unwind */ }
  };
}
