// mouaif web — Webpreview state bridge
//
// Glues the `webpreview` tool-card renderer (which can only stamp
// `data-web-preview-id` on the card and stash the payload in a side
// channel — it's an imperative DOM module with no Preact access) to
// the `<WebpreviewModal>` mounted in ChatView (which is Preact and
// owns the modal's open/close state).
//
// Three pieces:
//   1. The payload map (`payloads`) keeps the latest decoded
//      payload per id. The renderer writes here, the modal reads
//      from here when it opens.
//   2. A `subscribe(listener)` channel exposes a single 'open' event
//      fired when any webpreview card is tapped; the listener is the
//      ChatView's `setActive` setter. The renderer emits through
//      `requestOpen(id)`; ChatView consumes via `subscribe()`.
//   3. A document-level click delegate (installed at module import
//      time) translates a tap on `.tool-card[data-web-preview-id]`
//      into a `requestOpen(id)` call. Mounting on `document` instead
//      of the transcript ref makes the delegate survive every
//      transcript rebuild that wipes the old elements.
//
// This module lives outside Preact so the imperative renderer never
// has to import preact/hooks. The list itself is module-scoped:
// mouaif ships one chat at a time, so a global "currently active
// preview" is the simplest correct model.

const payloads = Object.create(null);
const listeners = new Set();
let activeId = '';

export function publish(id, payload) {
  if (!id) return;
  payloads[id] = payload;
}

export function getPayload(id) {
  return id ? payloads[id] : null;
}

export function getActivePayload() {
  return activeId ? payloads[activeId] : null;
}

export function clearPayloads() {
  for (const k of Object.keys(payloads)) delete payloads[k];
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestOpen(id) {
  if (!id) {
    closeActive();
    return;
  }
  if (!payloads[id]) return;
  activeId = id;
  for (const fn of listeners) {
    try { fn(id, payloads[id]); } catch { /* listener errors are ignored */ }
  }
}

export function closeActive() {
  if (!activeId) return;
  activeId = '';
  for (const fn of listeners) {
    try { fn('', null); } catch { /* listener errors are ignored */ }
  }
}

// Install the document-level click delegate once at module load.
// The handler is a passive `closest('.tool-card[data-web-preview-id]')`
// walk, so it has near-zero cost when no webpreview card is on
// screen and survives every chat / transcript switch. `capture: true`
// catches taps that would otherwise be caught by a header that
// toggles expand/collapse first; the webpreview card has no header
// toggle, the expand is owned by the head element, so stopping
// propagation here is correct.
if (typeof document !== 'undefined' && !document.__mouaifWebPreviewBound) {
  document.__mouaifWebPreviewBound = true;
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.closest) return;
    const card = target.closest('.tool-card[data-web-preview-id]');
    if (!card) return;
    e.stopPropagation();
    requestOpen(card.dataset.webPreviewId);
  }, true);
}

