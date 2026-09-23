# Modal sheets

## Overview

One hook implements the shared behaviour of every full-screen sheet: Escape dismisses it, Tab cycles inside it, and closing it restores focus. The public reference is [docs/features/modal-sheets.md](../../features/modal-sheets.md); this page records the code layout and why the pieces are split the way they are.

## Usage

`useModal({ onClose, active })` from `frontend/src/hooks/useModal.js` returns a ref for the sheet element. `active: false` keeps the sheet out of the keyboard stack without unmounting it (the Inspector's full-screen preview uses that while it is closed).

```js
const sheetRef = useModal({ onClose: () => { if (onClose) onClose(); } });
```

## Implementation notes

- File: `frontend/src/hooks/modalStack.js` (pure, DOM-free) — `openModal(token)`, `closeModal(token)`, `isTopModal(token)`, `modalDepth()`, `resetModalStack()`. The token is a fresh object per mount. Only the top token answers Escape or traps Tab, which is what makes stacked sheets (Git modal + commit-confirm sheet) behave; the old per-component listeners each ran on the same key, and the outer one — registered first — closed the wrong sheet. `closeModal` returns `true` when the caller was on top, i.e. when the keyboard is handed back.
- File: `frontend/src/hooks/useModal.js` (DOM wiring) —
  - `document.addEventListener('keydown', onKeyDown, true)` in capture phase, removed on unmount; `stopPropagation()` on the Escape it consumes so the key cannot also reach the composer/transcript behind the sheet.
  - `onClose` is read through a ref, so a parent re-rendering a fresh arrow function does not re-register the listener.
  - Tab trap: `focusableIn()` filters the sheet's controls by the standard focusable selector and skips `hidden`, `aria-hidden="true"`, `display: none` and `visibility: hidden` elements — a sheet that keeps a collapsed section in the DOM would otherwise trap Tab on an invisible control. `Shift+Tab` on the first control wraps to the last, `Tab` on the last wraps to the first, and either key pulls focus into the sheet when focus is outside it.
  - Focus restore: the element focused when the sheet opened is remembered and refocused on close, guarded by `document.contains(opener)`.
  - `initialFocus: 'first'` focuses the sheet's first control (falling back to the sheet itself with `tabindex="-1"` when it has none). Default is `'none'` on purpose: auto-focusing inside a sheet pops the iOS keyboard.
  - No scroll lock: `html, body` are `overflow: hidden` already (`frontend/src/base.css`) and the overlay covers the viewport.
- Adopters (each attaches the returned ref to its sheet element): `frontend/src/components/chat/CliModal.jsx`, `frontend/src/components/chat/GitModal.jsx` (two hooks: the modal, then the confirm sheet — declaration order is what puts the confirm sheet on top), `frontend/src/components/chat/McpErrorModal.jsx`, `frontend/src/components/chat/WebpreviewModal.jsx`, `frontend/src/components/chat/PreviewUrlPrompt.jsx`, `frontend/src/components/AgentFilePicker.jsx`, `frontend/src/components/inspector/PreviewPanel.jsx` (the full-screen overlay, `active: fullscreen`).
- File: `scripts/test-modal-hook.js` (30 assertions) — the stack's semantics, plus a source guard that each adopting component imports the hook, attaches the ref (directly or through the `sheetRef` prop the Git confirm sheet takes), and contains no `key === 'Escape'` or `addEventListener('keydown'` of its own. The DOM half (focus moves, computed styles) is exercised in Chrome rather than in Node; `scripts/test-inspector-preview-*.js` and `test-inspector-pick-mode.js` stub `useModal: () => ({ current: null })` in their mini hooks runtime.
- Not migrated, on purpose: the `@`-mention popup (`chat/atMention.js`), the tool popup, the composer's Escape handling (`chat/useChatState.js`), the authorization card (`chat/cards.js`) and the prompts picker (`SettingsPrompts.jsx`). These are popovers or inline surfaces where a focus trap is wrong; the model picker (`ModelPickerField.jsx`) uses a native `<dialog>` and its own `closeAndRestoreFocus`.

- `frontend/src/hooks/useModal.js` — the hook. `useModal({ onClose, active })` returns a ref to attach to the sheet element:

  ```js
  const sheetRef = useModal({ onClose: () => { if (onClose) onClose(); } });
  return h('div', { class: 'gm__overlay', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'gm__sheet', ref: sheetRef }, /* … */));
  ```

  It listens on `document` with capture, calls `stopPropagation()` on the Escape it consumes (so the key cannot also reach the composer or the transcript behind the sheet), and reads the latest `onClose` through a ref so a parent re-render cannot leave it holding a stale callback.
- `frontend/src/hooks/modalStack.js` — the pure stack that decides which sheet owns the keyboard: `openModal`/`closeModal`/`isTopModal`. A sheet that is not on top ignores `Escape` and leaves `Tab` alone, which is what makes nested sheets behave. It is DOM-free so it can be unit-tested (`scripts/test-modal-hook.js`).
- `scripts/test-modal-hook.js` — the stack's semantics (nested push/pop, closing a sheet that is not on top, re-opening a token, a three-sheet unwind) plus a source guard: every component that renders a sheet must import and use the hook, must attach the returned ref, and must not hand-roll a `keydown` listener for `Escape`. Adding a sheet means adding a row to that list.
- Not part of this: the `@`-mention popup, the tool popup, the composer's own `Escape` handling and the model picker. Those are popovers or text surfaces, not modal sheets — a focus trap would be wrong for them. The model picker uses a native `<dialog>` and already restores focus itself (see [Model picker](../../features/model-picker.md)).
- Verified at 360 px in Chrome against the built app: the CLI sheet, the Git sheet, the web-preview URL prompt and the agent file picker all open, take `Tab` inside, close on `Escape`, and leave the chat behind them intact; the prompt returns focus to the file-toolbar button that opened it.
