// mouaif web — webpreview state bridge
//
// The transcript renderer is imperative DOM while the preview dock is a
// Preact component. Successful webpreview results publish their user-facing
// screenshot through this tiny external store. The latest capture is shown
// above the composer and may be opened full-screen by the user.
const listeners = new Set();
let activePreview = null;

export function publish(payload) {
  if (!payload || !payload.thumbnail) return;
  if (!isNewer(payload, activePreview)) return;
  activePreview = payload;
  emit();
}

// isNewer(next, current) -> bool
//
// Whether `next` may replace the dock capture. Transcript backfill renders
// old rows after the latest ones, so a historical result can be published
// after a newer capture; it must not win. The old guard only compared when
// BOTH captures carried a parseable `capturedAt`, so a capture missing the
// timestamp (an older server, a hand-built payload) replaced a newer one
// unconditionally.
//
//   - no current capture          -> accept
//   - both timed                  -> accept unless strictly older
//   - next untimed, current timed -> reject: unknown age never beats known
//   - current untimed             -> accept (nothing to compare against;
//                                    the latest publish wins, as before)
function isNewer(next, current) {
  if (!current) return true;
  const currentTime = Date.parse(current.capturedAt || '') || 0;
  const nextTime = Date.parse(next.capturedAt || '') || 0;
  if (!currentTime) return true;
  if (!nextTime) return false;
  return nextTime >= currentTime;
}

export function getActivePayload() {
  return activePreview;
}

export function clearActive() {
  if (!activePreview) return;
  activePreview = null;
  emit();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) {
    try { listener(activePreview); } catch { /* listener errors are isolated */ }
  }
}
