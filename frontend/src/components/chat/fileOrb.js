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
