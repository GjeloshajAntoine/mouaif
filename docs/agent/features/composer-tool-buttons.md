# Composer tool buttons — implementation notes

> Agent-facing reference for [`docs/features/composer-tool-buttons.md`](../../features/composer-tool-buttons.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### Files

| File | Role |
|------|------|
| `frontend/src/components/chat/composerTools.js` | The preference reader — `composerToolsFromApp()` / `COMPOSER_TOOLS_DEFAULT` |
| `frontend/src/components/chat/useChatState.js` | Seeds the preference from `/api/settings` when a chat loads |
| `frontend/src/components/chat/Chat.jsx` | Draws the image button and the microphone only when enabled |
| `frontend/src/components/SettingsDefaults.jsx` | The two switches in Settings → Chat defaults |
| `src/settings.js` | `dictationButton: true`, `imageButton: true` in `DEFAULTS` |
| `src/server-shared.js` | Both keys in `CLIENT_SETTINGS_KEYS` |
| `scripts/test-composer-tools.mjs` | Preference, plumbing and render-guard tests |

### The preference

Both keys are **app-level display preferences** in the app SQLite store, next to `fileOrbButton`, `enterForNewline` and `autoRetry`. They change how the composer looks, never what the app can do, so a per-chat record would add a column and a migration for a cosmetic toggle — and would give the user a second place to look for one switch.

Reading is defensive, and a value that cannot be understood means **shown**:

```js
// frontend/src/components/chat/composerTools.js
export const DICTATION_BUTTON_KEY = 'dictationButton';
export const IMAGE_BUTTON_KEY = 'imageButton';
export const COMPOSER_TOOLS_DEFAULT = Object.freeze({ dictation: true, image: true });

export function composerToolsFromApp(snapshot) {
  const bag = snapshot && snapshot.app;
  const defaults = COMPOSER_TOOLS_DEFAULT;
  if (!bag || typeof bag !== 'object') return { dictation: defaults.dictation, image: defaults.image };
  return {
    dictation: readBool(bag[DICTATION_BUTTON_KEY], defaults.dictation),
    image: readBool(bag[IMAGE_BUTTON_KEY], defaults.image)
  };
}
```

A missing key, a failed `/api/settings` fetch, or a value the server could not store as a JSON boolean all resolve to `true`. The composer therefore only ever loses a control the user explicitly turned off — a button that silently disappeared after an update is worse than one that has to be switched off on purpose. The string forms (`'true'` / `'false'`) are accepted because the app store holds a TEXT blob, so a hand-edited `store.sqlite`, or a settings file merged from a project, can legitimately hand one back.

### Both keys must be in two server-side lists

A key is only readable by the web UI if it is in **`CLIENT_SETTINGS_KEYS`** (`src/server-shared.js`), the allowlist that strips server-only bookkeeping out of every `/api/settings` response. A key that is stored but not allowlisted is accepted by `PUT /api/settings/app`, written to SQLite, and then silently removed from every response — which looks exactly like a toggle that will not save. Being in `Settings.DEFAULTS` (`src/settings.js`) as well puts the key in `RESETTABLE_APP_KEYS`, so Settings → reset can clear it.

### Render guards

`ChatView` renders each optional button behind its flag:

```js
composerTools.dictation
  ? h(MicButton, { projectDir, chatId, promptRef: refs.promptInput, onTranscript, onStatus: onMicStatus, onProgress: onMicProgress })
  : null,
```

The hidden-image case keeps the `<input type="file">` mounted, because that element is the path a *pasted* image travels:

```js
// The file input is mounted either way. It is the path a pasted image
// (and the annotation editor's own capture) travels, so hiding the
// button removes a control, never a capability.
h('input', { ref: refs.imageInput, class: 'chat-view__image-input', type: 'file', … }),
```

### Mobile first

The composer row is the scarcest strip in the app: at 360–430 px it already carries the file button, the image button, the microphone, the text area and a send button. These switches exist because that row is the one place a phone screen cannot spare, and a control the user never taps is pure cost there. Everything stays a tap target of at least 44 × 44 when drawn, and nothing here is hover-dependent.

### Tests

`scripts/test-composer-tools.mjs` pins the reader (every defensive branch), both server-side lists, the render guards in `ChatView`, and — against a throwaway store — that `settings.js` persists each key and `settingsForClient()` still publishes it.

`scripts/test-dictation-chat.cjs` renders the real `ChatView` twice: once with the defaults (composer microphone and image button drawn) and once with both preferences `false` (neither is drawn, while the text area, the send button, the status line and the image file input are all still there).
