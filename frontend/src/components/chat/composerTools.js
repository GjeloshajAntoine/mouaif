// mouaif web — which tools the composer shows
//
// Two optional composer buttons can be switched off app-wide from
// Settings → App defaults → Chat defaults:
//
//   * the dictation microphone (`dictationButton`) — for the people who never
//     dictate, and who do not want to reach past a microphone that does
//     nothing on every message;
//   * the image button (`imageButton`) — for the people who dictate but never
//     attach a picture;
//   * the status line under the composer (`statusBar`) — the one-line row that
//     says "streaming…", the turn cost, "dictation added". Hidden, the row
//     keeps only the home-indicator inset; an error state is still shown so a
//     failed send never goes silent.
//
// Hiding is *not* disabling: the server routes (`/api/ai/transcribe`,
// image attachments on a send) stay exactly as they were, and an existing
// draft, a saved default or a project override is untouched. The switches only
// decide whether the composer draws the button — the two live in the row
// beside the message box, and that row is the one place a phone screen cannot
// spare.
//
// Both are **app-level display preferences** (`fileOrbButton`'s neighbours in
// the app SQLite store), not per-chat or per-project records: they change how
// the composer looks, never what the app can do, so a per-chat record would
// mean a column and a migration for a cosmetic toggle.
//
// Reading is defensive, the same way `fileOrbFromApp` reads the orb: a missing
// key, a failed `/api/settings` fetch, or a value the server could not store as
// a JSON boolean all resolve to `true` (the button is shown), so a composer
// only ever loses a control the user explicitly turned off. The string forms
// are accepted because the app store holds a TEXT blob — a hand-edited
// `store.sqlite`, or a settings file merged from a project, can legitimately
// hand us `'false'`.
export const DICTATION_BUTTON_KEY = 'dictationButton';
export const IMAGE_BUTTON_KEY = 'imageButton';
export const STATUS_BAR_KEY = 'statusBar';

// On by default: these are the buttons the composer has always drawn, and a
// feature that silently disappeared after an update is worse than one the user
// turns off on purpose.
export const COMPOSER_TOOLS_DEFAULT = Object.freeze({ dictation: true, image: true, status: true });

// readBool(raw, fallback) — the shared coercion. A real boolean wins; the two
// strings a TEXT store can hand back are read as what they say; anything else
// (absent, null, a number, prose) falls back.
function readBool(raw, fallback) {
if (typeof raw === 'boolean') return raw;
if (raw === 'true') return true;
if (raw === 'false') return false;
return fallback;
}

// composerToolsFromApp(snapshot) -> { dictation, image, status }
//
// `snapshot` is a `loadApp()` result (`{ app: { … } }`). Anything shaped
// differently reads as the defaults.
export function composerToolsFromApp(snapshot) {
const bag = snapshot && snapshot.app;
const defaults = COMPOSER_TOOLS_DEFAULT;
if (!bag || typeof bag !== 'object') return { dictation: defaults.dictation, image: defaults.image, status: defaults.status };
return {
dictation: readBool(bag[DICTATION_BUTTON_KEY], defaults.dictation),
image: readBool(bag[IMAGE_BUTTON_KEY], defaults.image),
status: readBool(bag[STATUS_BAR_KEY], defaults.status)
};
}
