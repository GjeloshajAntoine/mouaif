# Modal sheets

## Overview

Every full-screen sheet in the app — the CLI, Git, web-preview and MCP-error viewers, the web-preview URL prompt, the agent file picker and the Inspector's full-screen preview — shares one behaviour: **Escape dismisses the sheet, Tab stays inside it, and closing it returns focus to the control that opened it.** That behaviour lives in one place (`frontend/src/hooks/useModal.js`) instead of being re-implemented, slightly differently, in each component.

## Usage

Nothing to configure. Open any sheet and:

| Key / gesture | Result |
|---------------|--------|
| `Escape` | Dismisses the sheet |
| `Tab` | Moves to the next control inside the sheet; from the last control it wraps to the first |
| `Shift` + `Tab` | Moves backwards, wrapping from the first control to the last |
| Tap the backdrop | Dismisses the sheet (each sheet's own overlay handles this) |
| Tap the close button | Dismisses the sheet |

When two sheets are stacked — the Git modal with a commit-confirm sheet over it, the Inspector's full-screen preview over the Inspector — `Escape` closes **only the top one**, and the sheet underneath takes the keyboard back. Before this was centralised, each sheet registered its own document-level listener, so one `Escape` ran both handlers and the *outer* sheet closed first.

Closing a sheet puts focus back on whatever was focused before it opened, so a keyboard user lands on the button they tapped rather than at the top of the document.

### What a sheet deliberately does not do

- **No background scroll lock.** `html, body` are already `overflow: hidden` and the overlay covers the viewport, so the app behind a sheet cannot be scrolled; a second lock would only add a way to get out of sync.
- **No focus jump on open.** Auto-focusing a control when a sheet opens pops the on-screen keyboard on iOS, which is wrong for a sheet the user may only be reading. Pressing `Tab` moves focus in, and a sheet that *does* want focus in a field asks for it (`initialFocus: 'first'`) or focuses the field itself (the web-preview prompt focuses its URL input).
- **No click-outside handling.** Each sheet's overlay owns that, because the markup is per sheet.

## Implementation notes

- `frontend/src/hooks/useModal.js` — the hook. `useModal({ onClose, active })` returns a ref to attach to the sheet element:

  ```js
  const sheetRef = useModal({ onClose: () => { if (onClose) onClose(); } });
  return h('div', { class: 'gm__overlay', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'gm__sheet', ref: sheetRef }, /* … */));
  ```

  It listens on `document` with capture, calls `stopPropagation()` on the Escape it consumes (so the key cannot also reach the composer or the transcript behind the sheet), and reads the latest `onClose` through a ref so a parent re-render cannot leave it holding a stale callback.
- `frontend/src/hooks/modalStack.js` — the pure stack that decides which sheet owns the keyboard: `openModal`/`closeModal`/`isTopModal`. A sheet that is not on top ignores `Escape` and leaves `Tab` alone, which is what makes nested sheets behave. It is DOM-free so it can be unit-tested (`scripts/test-modal-hook.js`).
- `scripts/test-modal-hook.js` — the stack's semantics (nested push/pop, closing a sheet that is not on top, re-opening a token, a three-sheet unwind) plus a source guard: every component that renders a sheet must import and use the hook, must attach the returned ref, and must not hand-roll a `keydown` listener for `Escape`. Adding a sheet means adding a row to that list.
- Not part of this: the `@`-mention popup, the tool popup, the composer's own `Escape` handling and the model picker. Those are popovers or text surfaces, not modal sheets — a focus trap would be wrong for them. The model picker uses a native `<dialog>` and already restores focus itself (see [Model picker](model-picker.md)).
- Verified at 360 px in Chrome against the built app: the CLI sheet, the Git sheet, the web-preview URL prompt and the agent file picker all open, take `Tab` inside, close on `Escape`, and leave the chat behind them intact; the prompt returns focus to the file-toolbar button that opened it.
