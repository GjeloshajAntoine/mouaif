// mouaif web — the composer file button's "glass orb" preference.
//
// The file/git button next to the textarea has two looks:
//
//   false (default) — the flat circle the composer has always used.
//   true            — the animated glass orb (see
//                     docs/features/file-button-orb.md): a shaded sphere the
//                     chevron + folder glyph floats above on a slow 3D tilt.
//
// The choice is an **app-level** display preference (`fileOrbButton` in the
// app SQLite store), not a per-chat one: it changes how one button is drawn,
// never what it does, so a per-chat record would add a column and a migration
// for a cosmetic toggle. It sits next to the other Chat defaults
// (`enterForNewline`, `autoRetry`) and for the same reason — the composer is
// where it is seen.
//
// Reading is defensive: the guard below mirrors `useChatState.js`'s handling
// of the other app-level chat defaults. A missing key, a failed
// `/api/settings` fetch, or a value the server could not store as a JSON
// boolean all resolve to the flat default, so the button can never end up in
// an undefined style. The string forms are accepted because the app store
// holds a TEXT blob — a hand-edited `store.sqlite` (or a settings file merged
// from a project) can legitimately hand us `'true'`.
export const FILE_ORB_KEY = 'fileOrbButton';

// Off by default. The flat button is the conservative default: it matches the
// other composer controls, and the orb is an opt-in flourish.
export const FILE_ORB_DEFAULT = false;

// fileOrbFromApp(snapshot) -> boolean
//
// `snapshot` is a `loadApp()` result (`{ app: { … } }`). Anything shaped
// differently reads as the default.
export function fileOrbFromApp(snapshot) {
  const bag = snapshot && snapshot.app;
  if (!bag || typeof bag !== 'object') return FILE_ORB_DEFAULT;
  const raw = bag[FILE_ORB_KEY];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return FILE_ORB_DEFAULT;
}

// ---- Count sizing -------------------------------------------------------
//
// The orb draws the two counts *inside* the plate, and the plate is the
// folder silhouette's box — 20 x 17, matching ORB_FOLDER_W/H in
// FileToolbar.jsx and `.file-toolbar__plate` in chat-composer.css. The count
// box is that plate less the 2px inset the stats rule applies on every side,
// so it is 16 x 13, and the two numbers the formatter has to fit `+0` through
// `+995k` into.
//
// One fixed size cannot serve both ends of that range:
//
//   * sized for the 5-glyph worst case the digits render small enough that
//     every emboss offset is sub-pixel and melts into mush — which is exactly
//     the "no depth, no texture" the first fixed size produced, and `+995k`
//     overflowed its box rather than merely being small.
//   * sized for `+0`/`−0` — by far the common case, and the state the
//     reference render shows — there is room for a genuinely chunky digit,
//     where a 1px and a 2px extrusion step are both visible and the
//     letterpress reads as a solid.
//
// So the size follows the longest count actually being drawn, and each step
// has to clear BOTH budgets:
//
//   width   the widest string of `maxLen` glyphs, inside the 16px content
//           box. Measured in the app at weight 800 with tabular figures — the
//           per-string widths are NOT a constant per glyph, because `.` is
//           much narrower than a digit:
//
//             +0      1.19em     +99     1.77em
//             +9.9k   2.63em     +995k   2.92em
//
//   height  two stacked line boxes at `line-height: 0.85` inside the 13px
//           content box, *plus* the gap the two counts need between them.
//           This one is `maxLen`-independent: 2 * 0.85 * F <= 13, so F <=
//           ~7.6. It is deliberately not pushed to that ceiling — at 7.5px
//           the two line boxes sum to 12.75 of the 13px available and
//           `justify-content: space-between` has 0.25px left to separate
//           them, so the counts visually touch (measured: 1.4px of clear
//           space between the green and red ink, at dpr 12). 7px leaves
//           ~1.1px of box gap, which measures as ~2.5px of clear ink.
//
// Height binds at 2-3 glyphs, width takes over at 4-5:
//
//   2 glyphs -> 7px     (height; width would allow 13.4)
//   3 glyphs -> 7px     (height; width would allow 9.0)
//   4 glyphs -> 6px     (width:  16 / 2.63 = 6.08)
//   5 glyphs -> 5px     (width:  16 / 2.92 = 5.48)
//
// `maxLen` is the glyph count of the longer of the two rendered strings.
const ORB_FONT_STEPS = Object.freeze({ 2: 7, 3: 7, 4: 6, 5: 5 });
// orbCountFont(maxLen) -> a CSS length for the orb's count font size.
//
// Anything shorter than 2 or longer than 5 cannot come out of the formatter
// (the shortest is `+0`, the longest `+995k`), but the map is clamped rather
// than indexed so a future formatter change degrades to the nearest step
// instead of producing `undefined` and an invisible count.
export function orbCountFont(maxLen) {
  const n = Number(maxLen);
  if (!Number.isFinite(n) || n <= 2) return ORB_FONT_STEPS[2] + 'px';
  if (n >= 5) return ORB_FONT_STEPS[5] + 'px';
  return ORB_FONT_STEPS[Math.floor(n)] + 'px';
}
// The largest font size the orb will ever use, so a test can pin the ceiling
// independently of the table above.
export const ORB_FONT_MAX = 7;
