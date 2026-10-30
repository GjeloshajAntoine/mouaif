// frontend/src/backLayers.js — the system Back gesture closes the open sheet.
//
// Why it exists: a sheet, picker or full-screen viewer is not a page, so it
// has no history entry of its own. The Android Back button, the iOS edge
// swipe in an installed PWA and the browser Back button therefore skipped
// straight past it: Back with the model picker open over a chat left the
// chat for the chat list, with the picker still "open" in the abandoned view.
//
// Every open layer registers here with the function that closes it. While at
// least one is open, the router keeps a *guard* history entry on top of the
// page (same URL, marked in `history.state`), so the next Back pops the guard
// instead of the page. The router then calls `closeTopLayer()`, and pushes a
// fresh guard if another layer is still open underneath (Git confirm sheet
// over the Git modal: two Backs, one sheet each). A layer closed any other way
// (its ×, Escape, a tap outside) drops the guard again, so no dead Back press
// is left behind.
//
// Pure and DOM-free: router.js owns the history calls and plugs them in with
// `setBackLayerHistory()`; without it (tests, a page without the router) the
// registry only keeps the list. scripts/test-nav-history.mjs drives both.

const layers = [];
let wiring = null;
let disarmQueued = false;

// setBackLayerHistory({ arm, disarm }) — router.js: `arm()` makes sure a guard
// entry is on top, `disarm()` removes it when it is still the current entry.
export function setBackLayerHistory(next) {
  wiring = next;
}

// openBackLayer(close) — register an open layer; returns its release function
// (call it when the layer closes or unmounts, however that happened). `close`
// is what a Back press runs; it may refuse (an unsaved editor whose discard
// prompt was cancelled), and the layer then stays registered.
export function openBackLayer(close) {
  const layer = { close, released: false };
  layers.push(layer);
  if (wiring) wiring.arm();
  return () => releaseLayer(layer);
}

function releaseLayer(layer) {
  layer.released = true;
  const at = layers.indexOf(layer);
  if (at === -1) return;
  layers.splice(at, 1);
  if (layers.length) return;
  // Defer the guard removal by a microtask: a sheet that re-registers in the
  // same render (an effect re-run, one sheet swapped for another) keeps the
  // guard it already has instead of popping and pushing a history entry.
  if (disarmQueued) return;
  disarmQueued = true;
  Promise.resolve().then(() => {
    disarmQueued = false;
    if (!layers.length && wiring) wiring.disarm();
  });
}

// closeTopLayer() — a Back press popped the guard: close the top layer.
// Returns false when nothing was open. The layer leaves the list at once so
// the router can tell whether another one still needs a guard; if its close
// was refused (it is still mounted a tick later), it comes back on top.
export function closeTopLayer() {
  const layer = layers.pop();
  if (!layer) return false;
  layer.close();
  setTimeout(() => {
    if (layer.released || layers.includes(layer)) return;
    layers.push(layer);
    if (wiring) wiring.arm();
  }, 0);
  return true;
}

// openLayerCount() — how many layers are open.
export function openLayerCount() {
  return layers.length;
}

// resetBackLayers() — test seam: forget every layer and the wiring.
export function resetBackLayers() {
  layers.length = 0;
  wiring = null;
  disarmQueued = false;
}
