// mouaif web — Chat view utilities
//
// Tiny helpers used by multiple chat/* modules. Kept pure so the
// other modules can import without dragging in the whole view.

// CSS.escape polyfill for older mobile browsers; we only need to
// escape the chars that can appear in a tool call id (alnum, _, -).
export function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^A-Za-z0-9_-]/g, (c) => '\\' + c);
}
