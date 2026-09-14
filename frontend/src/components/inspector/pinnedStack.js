// pinnedStack — the two sticky strips at the top of the Styles panel.
//
// The panel has two things that must stay reachable while the rows below
// scroll, and they are not the same kind of thing:
//
//   1. the **identity row** (`.inspector__styles-pin`) — `tag#id.class` plus the
//      box size, which answers "what am I editing?" and stays put for the whole
//      panel; and
//   2. the **group chip row** (`.inspector__touch-tabs`) — the only index of the
//      touch surface, which is only read once the user is *inside* a group's
//      cards.
//
// Both are `position: sticky` against the panel's own scroller, and the second
// has to pin *directly below* the first rather than on top of it. That is a
// number CSS cannot know: the identity row's height follows its content — an
// error line appears under it when a tree hop fails, and the label ellipsizes
// or wraps with the element's own `tag#id.class`. A hard-coded offset therefore
// drifts the moment the row changes, and the drift is invisible until the two
// strips overlap again.
//
// So the height is measured and published as a custom property, and the chip
// row's `top` is written in terms of it (see `.inspector__touch-tabs`):
//
//   .inspector__styles-pin  { top: -6px; }          /* panel's own padding */
//   .inspector__touch-tabs  { top: calc(var(--insp-pin-h, 44px) - 6px); }
//
// The `-6px` is the panel's top padding, which the pin cancels with its own
// negative `top` so the row sits flush against the panel's border; the chip row
// pins into the same scrollport, so it subtracts the same 6 px.
//
// Everything here is a pure function over a duck-typed node (something with
// `getBoundingClientRect` for measurement and `style.setProperty` for the
// write), which is what makes the arithmetic testable without a browser.

// The custom property the height is published under. Read by
// `inspector-touch.css`; written by `applyPinHeight`.
export const PIN_HEIGHT_VAR = '--insp-pin-h';

// What the chip row falls back to before the first measurement: one `--tap`
// row, the height a pin with no error line has. The measurement is applied from
// a layout effect (see StylesPanel), so this value is only in force if the panel
// renders somewhere the effect cannot run; a wrong-for-one-frame offset would
// otherwise leave the chips a few px inside the identity row.
export const PIN_HEIGHT_FALLBACK = '44px';

// pinHeightPx — the pin's measured height as a whole-pixel CSS length, or `''`
// when nothing can be measured. Rounded (not fractional) because the value is
// compared against `getBoundingClientRect()` edges in the reveal maths, and a
// sub-pixel offset there shows up as a strip that is 1 px out of place.
//
// A detached or hidden node reports `0`: that is "no measurement", not "a pin
// of height zero", so it returns `''` and the caller leaves the property alone
// rather than pinning the chips to the top of the panel.
export function pinHeightPx(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return '';
  const box = node.getBoundingClientRect();
  const height = box && box.height;
  if (typeof height !== 'number' || !isFinite(height) || height <= 0) return '';
  return Math.round(height) + 'px';
}

// applyPinHeight — publish the pin's height to `root` (the panel element, so
// every sticky row inside it can read the property). Returns the value written,
// or `''` when there was nothing to measure and the property was cleared.
//
// It writes to `style` rather than to a class because the value changes as the
// user works (a failing hop adds an error line), and an inline custom property
// is the one place a measurement can live without a stylesheet per height.
export function applyPinHeight(root, node) {
  if (!root || !root.style || typeof root.style.setProperty !== 'function') return '';
  const px = pinHeightPx(node);
  if (!px) {
    if (typeof root.style.removeProperty === 'function') root.style.removeProperty(PIN_HEIGHT_VAR);
    return '';
  }
  if (root.style.getPropertyValue && root.style.getPropertyValue(PIN_HEIGHT_VAR) === px) return px;
  root.style.setProperty(PIN_HEIGHT_VAR, px);
  return px;
}

// watchPin — measure now, and again whenever the pin's own box changes, then
// return a stop function for the effect's cleanup.
//
// The observer is what keeps the two strips in step in the cases the panel does
// not render for: a font that finishes loading and re-wraps the label, a
// rotation that changes how many lines `tag#id.class` takes, a zoom. It is
// deliberately *not* the only measurement — `apply` runs immediately, so a
// target without `ResizeObserver` (an older WebView) still gets a correct chip
// offset instead of the fallback.
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
