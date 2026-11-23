# Lazy sheet loading failures

## Overview

The sheets that are not needed at startup — the CLI terminal, the Git modal,
the Files editor, screen capture, artifacts, the web-preview viewer and the
image annotator — are separate code chunks, downloaded the first time you open
them. When that download fails, the sheet now **says so and offers the way out**
instead of doing nothing.

Before this, a failed download was silent: tapping **Cli** in the File menu
opened the sheet's overlay with no sheet inside it, and every later tap did the
same. Nothing on screen explained it, and the session could not recover.

![The CLI sheet's error card at 390 px: a warning glyph, "Could not load the CLI
sheet. The app was probably updated since this page was loaded. Reload the app
to continue.", and two full-width buttons, Reload the app and
Close.](./images/lazy-sheet-error.png)

## Usage

Tap the menu entry as usual. If the sheet's code cannot be downloaded, the
sheet's place shows a short card:

- **What failed** — the sheet you asked for, named in plain words.
- **Why, most likely** — the app was updated since the page was loaded.
- **Reload the app** — fetches the current page and the current code. This is
  the action that fixes it.
- **Close** — dismisses the card. Tapping the backdrop does the same.

Opening the same entry again shows the same card. **There is deliberately no
Retry button** — see below.

Opening any *other* sheet is unaffected: only the chunk that failed is missing.

## Behavior

### Why the sheet used to be silent

Each sheet's component is referenced from the main bundle by a **content-hashed
file name** (`assets/CliModal-<hash>.js`). The page keeps that name in memory for
as long as the tab lives.

If mouaif is rebuilt or redeployed while the tab is open — including by an
in-app restart, or by a `--watch` rebuild — the server publishes a new build and
the old chunk file is gone. `src/server-web-static.js` answers a request for a
missing asset with `404 { "error": "Not found" }`, the dynamic `import()`
rejects, and the old code path reacted by clearing the component state it had
already cleared:

```js
// Before: a failure that changes nothing
import('./CliModal.jsx')
  .then((mod) => setCliModal(() => mod.CliModal))
  .catch(() => setCliModal(null));   // it was already null
```

Nothing re-ran (the effect's dependencies never changed) and nothing was
rendered (`open && View ? … : null`), so the sheet stayed dead until a full
reload. The service worker does not help: it never cached a chunk that was never
fetched, and activating a new worker deletes the old caches.

### The rule now

`frontend/src/hooks/useLazySheet.js` turns a load into explicit state:

| `status` | Meaning | What the caller renders |
| --- | --- | --- |
| `idle` | never asked for | nothing |
| `loading` | the chunk is in flight | the sheet, once `View` exists |
| `ready` | the chunk is loaded | the sheet |
| `error` | the chunk could not be loaded | the error card |

The sheet's "open" flag and its "code is here" status are separate, which is what
makes a failure renderable at all.

### Why Reload, and not Retry

The HTML specification memoizes a failed module in the document's module map.
Every later `import()` of the same specifier rejects again **without issuing a
request** — measured in Chrome, the first failure is one network request and the
second is zero. A Retry button would therefore be a button that provably cannot
work, which is worse than no button at all.

A fresh document is the one thing that does work: `index.html` is
network-first in the service worker (`frontend/build/sw-src.js`), so the reload
names the build the server actually has now, and the sheet opens normally.

```text
could not load  ──▶ error card ──▶ Reload the app ──▶ fresh index.html
                                                        │
                                                        └─▶ current chunk name ──▶ sheet opens
```

### Two placements

- **Replaces the sheet** — the CLI and Git modals, which the File toolbar owns.
  The card is itself a full-screen sheet (`.sheet-err__overlay` /
  `.sheet-err__sheet` in `frontend/src/sheets.css`), because the sheet it stands
  in for would have been one.
- **Fills an open sheet** — the Files editor, artifacts, screen capture, the
  web-preview viewer and the image annotator. Their own overlay is already up, so
  the block (`inline`) fills its body instead of opening a second overlay.

Every action is a full-width target of at least 44 px at 360 px wide, and the
row becomes a column of buttons on a tablet or desktop card.

## Tests

```bash
node scripts/test-lazy-sheet.js
```

- The message names the sheet, reads as a stale build, and never offers a retry.
- `reloadDocument()` reloads when there is a window and reports `false` when
  there is not.
- The state machine: a failure is `error` (not a silent `null`), is **not**
  re-requested, a success is not re-fetched, two taps in flight issue one
  request, and a chunk missing its export is reported.
- A source guard: `FileToolbar.jsx` and `Chat.jsx` route every lazily loaded
  sheet through `useLazySheet`, contain no swallowed `.catch(() => {})`, render
  the error card on `status === 'error'`, and the card itself offers only
  actions that can work.

Verified in the browser against the test mouaif: with the CLI chunk removed from
the served build, tapping File → Cli showed the card full-screen at 390 px with
44 px buttons, `Close` dismissed it, reopening showed it again, and restoring the
chunk plus **Reload the app** opened the terminal normally. Git, artifacts,
screen capture and the Files editor still opened their own sheets throughout.

## Related

- [CLI modal](cli-modal.md) — the sheet whose silent failure this fixes.
- [File toolbar](file-toolbar.md) — the menu that opens Git and CLI.
- [Frontend lazy settings](frontend-lazy-settings.md) — the same code-splitting
  approach for the settings pages.
