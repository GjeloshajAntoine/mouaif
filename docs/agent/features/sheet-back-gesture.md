# Back closes the open sheet — implementation notes

Public page: `docs/features/sheet-back-gesture.md`.

## Pieces

- `frontend/src/backLayers.js`: the list of open layers, each with its close function. Pure, with no DOM access. The router plugs in `arm`/`disarm` through `setBackLayerHistory()`.
- `frontend/src/hooks/useBackClose.js`: `useBackClose(active, onClose)` registers a layer while `active` is true. `useModal` calls it, and `back: false` opts a sheet out.
- `frontend/src/router.js`: the guard entry. `armGuard()` calls `history.pushState` with the same URL and `{ mouaifNav: id, mouaifSheet: true }`. `onPopState` works out whether a Back left the guard.
- `frontend/src/navHistory.js`: guard entries are recorded with `sheet: true`. They count as a step in `stepsBack` but never match as a target.

Hand-wired overlays that don't use `useModal`: `ModelPickerField`, `FileEditor`, `DraftCraftSheet`, `ToolPopup`, Inspector `ConfirmSheet`, `DetailSheet`, `DraftCraftAnnotator`, the full-screen `EscapeToExit`, and the tool-card image lightbox (`openBackLayer` directly).

## Rules the code relies on

- **One guard for the whole stack.** A Back press closes the top layer. If more layers remain, a new guard is pushed, so at most one guard exists at a time.
- **Disarm is deferred by a microtask.** A sheet that re-registers in the same render, such as an effect re-run, keeps its guard instead of popping and pushing it again.
- **A refused close is re-checked a tick later.** `closeTopLayer` removes the layer, then puts it back and re-arms if the layer was never released.
- **`nav()` and `replace()` on a guard use `location.replace`.** The new page takes the guard's slot, so its `prev` is the page under the sheet and step counts stay exact.
- **Stale guards are skipped.** A plain `href` link followed from a sheet leaves a guard behind. Landing on one with no layer open continues in the same direction.
- **The router ignores its own pops.** `ownPop` marks a pop the router triggered itself (disarm, a skip, or the reload cleanup). The popstate that follows is not treated as a Back press.
- **Chrome fires `popstate` before `hashchange`** on a fragment navigation, and only `popstate` between two entries with the same hash. The router listens to both, and `syncEntry` is idempotent.

## Tests

- `scripts/test-nav-history.mjs`, part 3: a simulated history covering push/close, closing with ×, stacked sheets, leaving through `nav()` or a plain link, a refused close, and a reload.
- `scripts/test-image-lightbox-teardown.js`: the lightbox registers a layer and releases it on every close path.
