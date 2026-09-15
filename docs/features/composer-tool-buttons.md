# Composer tool buttons

## Overview

Settings → App defaults → Chat defaults has two switches that decide which optional tools the chat composer draws beside the message box: **Dictation microphone in the composer** and **Image button in the composer**. Both are on by default. Turning one off removes that button from the composer row — for a user who never dictates, or never attaches a picture, and who does not want to reach past a control that does nothing for them every time they send a message.

Hiding is **not** disabling. The routes behind the buttons stay exactly as they were, so a hidden control removes a way to *reach* a capability, never the capability:

| Hidden | Still works |
|--------|-------------|
| Dictation microphone | The `#/dictation` page (record, transcribe, edit, copy / insert / send), the app-level dictation model choice, and `POST /api/ai/transcribe` |
| Image button | Pasting an image into the composer, the annotation editor, and image attachments on a send |

## Usage

1. Open **Settings → App defaults** (the **Chat defaults** group).
2. Find the row you want and flip its switch:
   - **Dictation microphone in the composer** — off removes the microphone from the composer row.
   - **Image button in the composer** — off removes the picture-attachment button.
3. Each row saves immediately (there is no Save button) and the choice applies app-wide, so every project's composer obeys it. The status line under the row confirms what happened.

Open any chat to see the result. The composer keeps the text area, the send button and the status line, so hiding both optional tools leaves a narrower row rather than an empty one.

Turn a switch back on and the button returns — including in a chat that is already open, because the chat re-reads the app settings when its data loads.

### What does not change

- **The tap target.** An optional button is either drawn exactly as it was (44 × 44, its usual margin) or not drawn at all. Nothing is squeezed to make room.
- **The keyboard.** Enter / Shift+Enter behaviour is `enterForNewline` and is untouched.
- **The draft.** Whatever is already typed, and any attachment already made, stays put.

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
