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
