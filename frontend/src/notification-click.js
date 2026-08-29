// mouaif web — notification navigation and iOS cold-launch handoff.
//
// iOS can relaunch an installed PWA at start_url instead of honoring
// clients.openWindow(). The service worker stores the intended URL in this
// small IndexedDB store; the visible page consumes it and updates its hash.

const CLICK_DB = 'mouaif-push-click';
const CLICK_STORE = 'clicks';
const CLICK_KEY = 'latest';
const CLICK_TTL_MS = 60 * 1000;

function openClickDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const request = indexedDB.open(CLICK_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CLICK_STORE)) db.createObjectStore(CLICK_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}

export async function clearStoredClickTarget() {
  try {
    const db = await openClickDb();
    await new Promise((resolve) => {
      const tx = db.transaction(CLICK_STORE, 'readwrite');
      tx.objectStore(CLICK_STORE).delete(CLICK_KEY);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
    db.close();
  } catch { /* best-effort */ }
}

async function readPendingClickTarget() {
  try {
    const db = await openClickDb();
    const row = await new Promise((resolve) => {
      const tx = db.transaction(CLICK_STORE, 'readwrite');
      const store = tx.objectStore(CLICK_STORE);
      const request = store.get(CLICK_KEY);
      request.onsuccess = () => {
        const value = request.result;
        if (value) store.delete(CLICK_KEY);
        resolve(value || null);
      };
      request.onerror = () => resolve(null);
    });
    db.close();
    return row && row.url && Date.now() - (row.at || 0) < CLICK_TTL_MS ? row.url : null;
  } catch { return null; }
}

export function navigateToNotificationTarget(value) {
  if (!value || typeof window === 'undefined') return;
  let target;
  try { target = new URL(value, window.location.origin); } catch { return; }
  if (target.origin !== window.location.origin || target.pathname !== '/') return;

  const hash = target.hash || '#/projects';
  if (window.location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else window.location.hash = hash;
  window.focus();
}

export function consumePendingNotificationClick() {
if (typeof document === 'undefined') return;
const check = () => {
if (document.visibilityState !== 'visible') return;
// Read-and-clear is idempotent: once consumed the store is empty, so
// a later fire (visibilitychange, pageshow, focus) is a no-op. The
// page re-checks on focus so an already-open window that a suspended
// iOS PWA was woken into still picks up a target that the service
// worker wrote before posting its (possibly dropped) NAVIGATE message.
readPendingClickTarget().then(navigateToNotificationTarget);
};
check();
document.addEventListener('visibilitychange', check);
window.addEventListener('pageshow', check);
// `focus` fires when a background PWA is brought forward, which is how
// tapping a notification surfaces a suspended window on iOS without a
// reliable visibilitychange. Debounce so overlapping events collapse to
// one read.
let focusTimer = null;
window.addEventListener('focus', () => {
clearTimeout(focusTimer);
focusTimer = setTimeout(check, 0);
});
}
