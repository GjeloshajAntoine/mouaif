// mouaif web — notification navigation and iOS cold-launch handoff.
//
// iOS can relaunch an installed PWA at start_url instead of honoring
// clients.openWindow(). The service worker stores the intended URL in this
// small IndexedDB store; the visible page consumes it and updates its hash.

const CLICK_DB = 'mouaif-push-click';
const CLICK_STORE = 'clicks';
const CLICK_KEY = 'latest';
const CLICK_TTL_MS = 60 * 1000;
// How long the freshly loaded page keeps re-reading the click store. A cold
// launch wakes the service worker from the click itself, so its write can
// land AFTER this page has already run its startup read (the worker has to
// boot, then open IndexedDB). Without a short poll that late write is only
// seen if the user happens to trigger focus/visibilitychange, and the tap
// silently lands on the chats list.
const COLD_LAUNCH_POLL_MS = 250;
const COLD_LAUNCH_POLL_WINDOW_MS = 5000;

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
const initialHash = window.location.hash;
// consumeOnce() reads the store and navigates when it holds an in-window
// target. Read-and-clear makes it idempotent: once consumed the store is
// empty, so a later fire (visibilitychange, pageshow, focus, poll) is a
// no-op. Resolves true when a target was applied.
const consumeOnce = () => {
if (document.visibilityState !== 'visible') return Promise.resolve(false);
return readPendingClickTarget().then((url) => {
if (!url) return false;
navigateToNotificationTarget(url);
return true;
});
};
const check = () => { consumeOnce(); };
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
// Cold-launch late write: the click wakes the worker, so it can store the
// target a moment after this page's startup read. Poll briefly instead of
// depending on a focus/visibilitychange that may never come. The poll stops
// on the first applied target and also as soon as the user has navigated
// away from where the app launched, so it can never yank a moving user.
let pollTimer = null;
const stopPolling = () => {
if (pollTimer == null) return;
clearInterval(pollTimer);
pollTimer = null;
};
const poll = () => {
if (document.visibilityState !== 'visible') return;
if (window.location.hash !== initialHash) { stopPolling(); return; }
consumeOnce().then((applied) => { if (applied) stopPolling(); });
};
pollTimer = setInterval(poll, COLD_LAUNCH_POLL_MS);
setTimeout(stopPolling, COLD_LAUNCH_POLL_WINDOW_MS);
}
