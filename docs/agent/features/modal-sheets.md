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
