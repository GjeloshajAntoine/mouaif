// mouaif web — webpreview state bridge
//
// The transcript renderer is imperative DOM while the preview dock is a
// Preact component. Successful webpreview results publish their user-facing
// screenshot through this tiny external store. The latest capture is shown
// above the composer and may be opened full-screen by the user.
const listeners = new Set();
let activePreview = null;
// Recent screenshot captures, newest last, so the viewer can compare a
// design before and after a prompt. Kept in memory only (screenshots are
// data URLs); cleared with the active preview when the chat changes.
const HISTORY_LIMIT = 6;
let history = [];
// Bumped whenever the dock and viewer should reload a Live frame in place
// (after an agent turn ends while auto-refresh is on).
let reloadStamp = 0;
const reloadListeners = new Set();

// A payload is either a screenshot ({ thumbnail }) or a Live iframe
// ({ mode: 'live', url }) requested by the agent.
export function isPublishable(payload) {
  if (!payload) return false;
  if (payload.thumbnail) return true;
  return payload.mode === 'live' && typeof payload.url === 'string' && !!payload.url;
}

export function publish(payload) {
  if (!isPublishable(payload)) return;
  if (!isNewer(payload, activePreview)) return;
  activePreview = payload;
  if (payload.thumbnail) remember(payload);
  emit();
}

function remember(payload) {
  const last = history[history.length - 1];
  if (last && last.thumbnail === payload.thumbnail) return;
  history = history.concat([payload]).slice(-HISTORY_LIMIT);
}

// getHistory(url) -> captures of `url`, oldest first.
export function getHistory(url) {
  if (!url) return [];
  return history.filter((item) => item.url === url);
}

export function requestReload() {
  reloadStamp += 1;
  for (const listener of reloadListeners) {
    try { listener(reloadStamp); } catch { /* isolated */ }
  }
}

export function getReloadStamp() {
  return reloadStamp;
}

export function subscribeReload(listener) {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
}

// Auto-refresh after each agent turn, remembered on the device.
const AUTO_KEY = 'mouaif.webpreview.autoRefresh';
export function readAutoRefresh() {
  try { return localStorage.getItem(AUTO_KEY) !== 'off'; } catch { return true; }
}
export function writeAutoRefresh(on) {
  try { localStorage.setItem(AUTO_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
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
  history = [];
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
