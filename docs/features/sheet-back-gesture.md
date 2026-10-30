# Back closes the open sheet

## Overview

The system Back gesture closes whatever sheet, picker or viewer is open, instead of leaving the page under it. This applies to the Android Back button, the iOS edge swipe in an installed app, and the browser's Back button. Before this change, Back with the model picker open over a chat dropped you on the chat list.

## Usage

Open any sheet and go Back:

| On screen | One Back | Next Back |
|---|---|---|
| A sheet over a chat (model picker, Git, CLI, file editor, tool settings, an image) | Closes the sheet, stays in the chat | Leaves the chat |
| Two stacked sheets (Git commit confirm over Git) | Closes the top sheet | Closes the sheet below |
| An Inspector panel in full screen | Leaves full screen | Leaves the Inspector page |
| A sheet closed with its ×, `Escape` or a tap outside | — | Leaves the page, as if the sheet was never opened |

- A sheet that asks before closing still asks. In the file editor with unsaved changes, Back shows the discard prompt, and the editor stays open if you cancel.
- A link inside a sheet opens its page in the sheet's place. Back from that page returns to the page the sheet was open on, with the sheet closed.

## Behavior

- While any sheet is open, the app keeps one extra history entry with the page's own address on top. Back removes that entry and closes the top sheet.
- Closing the last sheet any other way removes the extra entry, so no Back press is wasted.
- Reloading while a sheet was open drops the leftover entry, so the page reopens without a sheet.
- Sheets built on the shared sheet hook get this automatically. Other overlays opt in with one call (`useBackClose(open, close)`).

## Related

- [Modal sheets](modal-sheets.md) — `Escape`, `Tab` and focus behavior shared by every sheet.
- [Settings back navigation](settings-back-navigation.md) — where the in-app Back arrows go.
- [Routing](routing.md) — every address the app answers.
