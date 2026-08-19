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
  // Transcript backfill renders old rows after the latest rows. Do not let a
  // historical card replace a newer dock capture when its lazy body mounts.
  const currentTime = Date.parse(activePreview && activePreview.capturedAt || '') || 0;
  const nextTime = Date.parse(payload.capturedAt || '') || 0;
  if (activePreview && currentTime && nextTime && nextTime < currentTime) return;
  activePreview = payload;
  emit();
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
