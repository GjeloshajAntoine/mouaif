# Lazy sheet loading failures — implementation notes

> Agent-facing reference for [`docs/features/lazy-sheet-loading.md`](../../features/lazy-sheet-loading.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### The silent-failure bug

Every full-screen sheet that is not needed at startup is a separate hashed chunk
(`assets/CliModal-<hash>.js`, `GitModal-<hash>.js`, `FileEditor-<hash>.js`,
`ScreenCapturePanel`, `ArtifactsModal`, `WebpreviewModal`,
`DraftCraftAnnotator`). The chunk URL lives in the entry bundle already in
memory, so a rebuild while the tab is open leaves the page asking for a file the
server no longer has. [src/server-web-static.js](../../../src/server-web-static.js)
`serveWebFile` answers a missing asset with `404 { error: 'Not found' }`.

The old reaction threw the failure away:

```js
import('./CliModal.jsx')
  .then((mod) => { if (!cancelled) setCliModal(() => mod.CliModal); })
  .catch(() => { if (!cancelled) setCliModal(null); });   // already null
```

Three things then held the failure in place:

- the effect's deps were `[cliOpen, CliModal]`, and neither changed;
- the render guard was `cliOpen && CliModal ? … : null`, so nothing was drawn;
- re-tapping the menu item only re-set `cliOpen = true`, which was already true.

The same shape existed in `Chat.jsx` (`useLazyView`, the file editor's own
loader, `HooksDock.jsx`) and `FileToolbar.jsx` (both Git and CLI).

### The hook

[frontend/src/hooks/useLazySheet.js](../../../frontend/src/hooks/useLazySheet.js)
exports three things:

- `useLazySheet(name, loader)` → `{ View, status, error, load }`.
  `status` is `'idle' | 'loading' | 'ready' | 'error'`. `load()` is idempotent
  via `startedRef` — one attempt per document. `loader` is held in a ref because
  callers pass an inline arrow. A chunk that resolves without the expected export
  throws `missing export <name>` and lands in the same `error` state.
- `lazySheetMessage(error, label)` — the sentence. A `/fetch|chunk|import|module|404|not found|loading/i`
  match (or no message at all) means "the app was probably updated since this
  page was loaded"; anything else is shown verbatim. Either way the tail is
  `Reload the app to continue.`
- `reloadDocument()` — `window.location.reload()`, returning `false` with no
  window (tests).

### Why there is no Retry

The HTML spec memoizes a **failed** module in the document's module map. A second
`import()` of the same specifier rejects from the memo with **no network
request**. Measured in the test Chrome:

```text
first import()  -> 1 resource request, rejects
second import() -> 0 resource requests, rejects identically
```

So a Retry control would be a no-op dressed as an action. The only recovery that
works is a fresh document: `/index.html` is network-first in
[frontend/build/sw-src.js](../../../frontend/build/sw-src.js), so the reload
picks up the current entry bundle and therefore the current chunk names. A chunk
refetched from the same document is *not* an option — do not reintroduce a
retry without changing that.

### Component

[frontend/src/components/chat/LazySheetError.jsx](../../../frontend/src/components/chat/LazySheetError.jsx)
renders the card. Two placements:

- default: `.sheet-err__overlay` + `.sheet-err__sheet`, a full-screen sheet that
  *stands in for* the one that could not load (CLI, Git — owned by the File
  toolbar). A backdrop tap calls `onClose`.
- `inline`: `.lazy-err` alone, filling a sheet whose own overlay is already up
  (files editor, artifacts, screen capture, web preview, image annotator).

Styles are appended to [frontend/src/sheets.css](../../../frontend/src/sheets.css).
The overlay/sheet block is copied from the shared idiom rather than added to its
selector lists, because each modal's list is fixed and the failed component is
exactly what would have supplied a modal-specific class. `.lazy-err__btn` keeps
the `--tap` (44 px) floor and the actions become a row at `min-width: 720px`.

### Call sites

- [frontend/src/components/chat/FileToolbar.jsx](../../../frontend/src/components/chat/FileToolbar.jsx) —
  `useLazySheet('GitModal', …)` and `useLazySheet('CliModal', …)`; `handleGit` /
  `handleCli` call `load()` on the tap that opens, and the render is
  `open ? (status === 'error' ? errorCard : View ? sheet : null) : null`.
- [frontend/src/components/chat/Chat.jsx](../../../frontend/src/components/chat/Chat.jsx) —
  the capture panel, artifacts, the web-preview viewer, the image annotator and
  the file editor, each with a `load()` on open and an `inline` error card.

### What this does not cover

- `frontend/src/components/chat/HooksDock.jsx` still loads its editor with a
  `.catch` that sets an error string. It renders that string, so it is not
  silent, but it is not on the shared rule yet.
- The PWA service worker does not cache lazily loaded chunks before they are
  first fetched, so it cannot mask the 404 — by design (a cached copy of a chunk
  the server no longer names would be a half-updated UI).

## Tests

`scripts/test-lazy-sheet.js` loads `frontend/src/hooks/useLazySheet.js` through a
`data:` URL (after stripping the `preact/hooks` import, which a data URL cannot
resolve) and drives:

- the message (names the sheet, reads as a stale build, never says "try again",
  normalizes 404/chunk/bare-message cases, keeps a non-network message);
- `reloadDocument()` with and without a window;
- a mirror of the state machine: failure is `error` not `null`, a failed import
  is not re-requested, a success is not re-fetched, two in-flight taps make one
  request, a missing export is reported;
- source guards on `FileToolbar.jsx` and `Chat.jsx`: every lazy sheet goes
  through `useLazySheet`, no swallowed `.catch(() => {})`, `status === 'error'`
  renders `LazySheetError`;
- a guard on `LazySheetError.jsx` (offers Reload, never Try again, is a
  `role="dialog"` overlay with `.sheet-err__overlay`) and on the new CSS
  (`.lazy-err--inline`, the 44 px floor).

Browser verification (test mouaif in Docker + the `:9222` Chrome): the CLI chunk
was moved out of the served build so `/assets/CliModal-<hash>.js` returned 404.
Tapping File → Cli at 390 px showed `.sheet-err__overlay` fixed at `z-index: 60`
covering the viewport, with two 44 px buttons; **Close** dismissed it and
reopening showed the same card (one attempt per document); restoring the chunk
and reloading opened the terminal normally (`CLI — Shell (/bin/sh)` in
`/workspace/example`). Git, artifacts, screen capture and the Files editor opened
their own sheets throughout.
