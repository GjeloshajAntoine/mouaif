// mouaif web — service worker registration and update flow.
//
// Scope: '/'. The app now lives at the root, so the SW intercepts
// the whole origin. Anything that is not a PWA static asset (API,
// SSE, OAuth callback, /data) is explicitly bypassed by the SW; this
// module mirrors that guard so the offline signal only reacts to the
// app shell, not live data endpoints.
//
// Update strategy:
//   - On every page load, register /sw.js.
//   - If a new SW is found (updateAvailable signal fires), show
//     the "Update available — reload" banner.
//   - The user is in control: we only call skipWaiting() once they
//     accept, then a full reload picks up the new bundle. This
//     avoids the half-loaded "old HTML + new JS" state.
//
// Offline signal:
//   - Maintain an offline signal the UI can subscribe to. It's
   `true`
//     whenever the last same-origin app-shell fetch failed (network-
//     first branch returned the cached shell) or the browser's
//     navigator.onLine flips to false while a fetch is pending.

import { signal } from '@preact/signals';

export const updateAvailable = signal(false);
export const offline = signal(typeof navigator === 'undefined' ? false : !navigator.onLine);

let _registration = null;
let _waitingResolve = null;

function isProduction() {
  // Vite injects import.meta.env.PROD as `true` for build output.
  // In dev mode we skip SW registration entirely so HMR stays fast
  // and stale code never lands in the cache.
  try { return !!import.meta.env && import.meta.env.PROD === true; }
  catch { return false; }
}

// The app's own shell path = same-origin GET on the root that is not a
// live API surface. The SW scope is '/', so an API fetch failing must
// not flip the offline banner (the server is up, just that call failed).
function sameOriginAppPath(url) {
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin) return false;
    const p = u.pathname;
    if (p === '/api' || p.startsWith('/api/')) return false;
    if (p === '/events' || p === '/data' || p.startsWith('/oauth/')) return false;
    return true;
  } catch { return false; }
}

function trackOnlineStatus() {
  const set = () => { offline.value = !navigator.onLine; };
  window.addEventListener('online', set);
  window.addEventListener('offline', set);
}

// Wrap fetch so a same-origin app-shell fetch failure flips the offline
// signal back on. We don't want to wait for the next "online" event
// when the browser is online but the mouaif server is down — the
// "offline" banner is the right hint for both.
function trackFetchFailures() {
  if (typeof window === 'undefined' || !window.fetch) return;
  const orig = window.fetch.bind(window);
  window.fetch = async function trackedFetch(input, init) {
    const req = input instanceof Request ? input : new Request(input, init);
    let url;
    try { url = typeof req.url === 'string' ? req.url : String(input); } catch { url = ''; }
    try {
      const res = await orig(req);
      if (sameOriginAppPath(url) && res && res.ok) offline.value = false;
      return res;
    } catch (err) {
      if (sameOriginAppPath(url)) offline.value = true;
      throw err;
    }
  };
}

async function handleWaiting(worker) {
  // A new SW is installed and waiting. Expose a promise the UI can
  // await; the user pressing the "Reload" button calls
  // applyUpdate(), which posts SKIP_WAITING and reloads.
  updateAvailable.value = true;
  return new Promise((resolve) => { _waitingResolve = resolve; });
}

export async function applyUpdate() {
  if (!_registration || !_registration.waiting) return;
  if (_waitingResolve) _waitingResolve();
  _registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  // The SW's controllerchange listener (see below) reloads once
  // the new worker takes over.
}

export function registerServiceWorker() {
  if (!isProduction()) return;
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'GET_VISIBILITY_STATE' && event.ports && event.ports[0]) {
      // A service worker can be suspended between pushes, which erases
      // its in-memory visibility table. Answer a push-time query from the
      // newly awakened worker with the page's current, authoritative state.
      event.ports[0].postMessage(visibilitySnapshot());
      return;
    }
    if (msg.type === 'NAVIGATE' && msg.url) {
      const url = new URL(msg.url, window.location.origin);
      if (url.origin !== window.location.origin) return;
      // The app now lives at the root; only accept NAVIGATE targets
      // that point at the app shell (pathname '/'), so a notification
      // click can never move an open window to an API path.
      if (url.pathname !== '/') return;
      const next = url.hash || '#/projects';
      // Only rewrite the hash when it actually changed. Safari treats
      // `location.hash = <same value>` as a no-op (no hashchange, no
      // scroll) while Chrome re-fires hashchange even for equal hashes —
      // so this guard must compare first and dispatch manually only when
      // the target already equals the current hash.
      if (window.location.hash !== next) {
        window.location.hash = next;
      } else {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
      window.focus();
      // This NAVIGATE was delivered to an already-open window: the click
      // target (if any) was consumed here, so clear it to stop a later
      // cold launch from redirecting into a stale chat.
      clearStoredClickTarget();
    }
  });
  trackFetchFailures();

  // Defer registration until after first paint so the SW install
  // doesn't compete with the entry bundle download. A user who
  // navigates away during install never pays for it.
  const schedule = (cb) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(cb, { timeout: 2500 });
    else setTimeout(cb, 1500);
  };

  schedule(() => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((reg) => {
        _registration = reg;
        if (reg.waiting && reg.active) {
          // A new SW installed while a previous one was active.
          handleWaiting(reg.waiting);
        }
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              handleWaiting(sw);
            }
          });
        });

        // Periodic update check on visibility change — picking up
        // a new version after a long-idle tab returns. Browsers
        // already do this in some cases, but the explicit check
        // makes the behaviour predictable across engines.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch(() => {
        // SW registration failures (e.g. a private-mode browser that
        // disallows ServiceWorkers) are non-fatal: the app still
        // works as a normal web page.
      });
  });

  // When a new worker takes control, reload once. Pages loaded
  // after this fires already picked up the new SW via clients.claim().
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

// Refresh the Projects screen (chat list, titles, running states) in
// the background when the app comes back to the foreground after a
// push notification tap opened this window. The chat view only ever
// reconciles the chat it is showing, so without this the list behind
// a completed/renamed chat would show stale titles and a chat started
// from a notification would not appear until the user re-entered the
// tab. The service worker suppresses the OS notification for the
// already-focused chat, so this visibility path only fires when the
// notification click actually brought the app forward.
export function refreshProjectsOnVisible() {
  if (typeof document === 'undefined') return;
  const handler = () => {
    if (document.visibilityState !== 'visible') return;
    const hash = window.location.hash || '';
    if (hash.startsWith('#/chat') || hash.startsWith('#/settings')) return;
    // Re-enter the route: hashchange re-runs ProjectsView's effect.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  document.addEventListener('visibilitychange', handler);
}

// ---- Visibility reporting (notification suppression) ---------------
//
// The service worker suppresses a push notification when the user is
// already looking at that chat, but WindowClient.focused /
// visibilityState are unreliable on some engines (Safari, iOS PWA).
// The page always knows its own document.visibilityState exactly, so
// we report { hash, visible, focused } to the worker on a persistent
// MessageChannel — on load, whenever visibility or focus changes, and
// on every hash change (the app is hash-routed). The worker keeps the
// last report per client and consults it in the push handler (see
// sw-src.js — clientViews).

let _visibilityReporting = false;

function visibilitySnapshot() {
  return {
    type: 'VISIBILITY_STATE',
    hash: window.location.hash || '',
    visible: document.visibilityState === 'visible',
    focused: typeof document.hasFocus === 'function' ? document.hasFocus() : false
  };
}

export function startVisibilityReporting() {
  if (_visibilityReporting) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  _visibilityReporting = true;

  let port = null;

  const report = () => {
    const state = visibilitySnapshot();
    try { if (port) port.postMessage(state); } catch { port = null; }
    // Fallback for the window before the channel is established (or
    // engines where controller is briefly null): a one-shot message.
    // Safe to send alongside the port — both write the same table.
    try {
      const sw = navigator.serviceWorker.controller;
      if (sw) sw.postMessage(state);
    } catch { /* best-effort */ }
  };

  const openChannel = () => {
    const sw = navigator.serviceWorker.controller;
    if (!sw || port) return;
    try {
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (event) => {
        // The worker does not talk back today; keep the handler so
        // future pings don't surface as unhandled messages.
        void event;
      };
      // Client.id is not exposed to pages; the worker identifies us by
      // event.source for one-shot messages and by the clientId we send
      // with the port. crypto.randomUUID gives us a stable per-page id
      // the worker stores alongside the report.
      sw.postMessage({ type: 'VISIBILITY_PORT', clientId: _pageClientId() }, [channel.port2]);
      report();
    } catch { port = null; }
  };

  const onVisibility = () => report();
  const onHashChange = () => report();

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', report);
  window.addEventListener('blur', report);
  window.addEventListener('hashchange', onHashChange);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    port = null;
    openChannel();
  });

  openChannel();
  report();
}

let _uuid = null;
function _pageClientId() {
  if (_uuid) return _uuid;
  try {
    _uuid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
  } catch { _uuid = String(Math.random()).slice(2) + Date.now(); }
  return _uuid;
}

// ---- Notification-click handoff (iOS PWA) --------------------------
//
// When the app is closed or suspended, iOS Safari relaunches the
// installed PWA at its start_url on a notification tap and does not
// support clients.openWindow() from the service worker. The SW writes
// the click URL to IndexedDB (CLICK_DB in sw-src.js) before attempting
// to open a window; the freshly launched page reads it here and
// navigates to the chat. The target is cleared after one read so a
// later manual launch never jumps into a stale chat.

const CLICK_DB = 'mouaif-push-click';
const CLICK_STORE = 'clicks';
const CLICK_KEY = 'latest';

function readPendingNotificationClick() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let db;
    const req = indexedDB.open(CLICK_DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(CLICK_STORE)) d.createObjectStore(CLICK_STORE);
    };
    req.onsuccess = () => {
      db = req.result;
      const tx = db.transaction(CLICK_STORE, 'readwrite');
      const store = tx.objectStore(CLICK_STORE);
      const get = store.get(CLICK_KEY);
      get.onsuccess = () => {
        const row = get.result;
        if (row && row.url && Date.now() - (row.at || 0) < 60 * 1000) {
          store.delete(CLICK_KEY);
          resolve(row.url);
        } else {
          if (row) store.delete(CLICK_KEY);
          resolve(null);
        }
      };
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

// Clear the stored click target without navigating. Called when an
// already-open window consumed a NAVIGATE message, so a later cold
// launch cannot redirect into a stale chat.
function clearStoredClickTarget() {
  if (typeof indexedDB === 'undefined') return;
  const req = indexedDB.open(CLICK_DB, 1);
  req.onsuccess = () => {
    const db = req.result;
    try {
      const tx = db.transaction(CLICK_STORE, 'readwrite');
      tx.objectStore(CLICK_STORE).delete(CLICK_KEY);
    } catch { /* best-effort */ }
  };
  req.onerror = () => { /* best-effort */ };
}

function applyPendingNotificationClick(url) {
  if (!url) return;
  let parsed;
  try { parsed = new URL(url, window.location.origin); } catch { return; }
  // The app lives at the root; only accept a click target whose pathname
  // is the app shell ('/'), never an API path.
  if (parsed.origin !== window.location.origin || parsed.pathname !== '/') return;
  const hash = parsed.hash || '#/projects';
  if (window.location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;
  }
  window.focus();
}

// Consume a click target left by the service worker: on startup (a cold
// launch from a closed app) and whenever the app becomes visible again
// (an OS relaunch that did not produce a window the SW could reach).
// Only fires for a target written within the last minute, so a normal
// manual launch is never redirected.
export function consumePendingNotificationClick() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const check = () => {
    if (document.visibilityState !== 'visible') return;
    readPendingNotificationClick().then((url) => applyPendingNotificationClick(url));
  };
  check();
  document.addEventListener('visibilitychange', check);
}

// ---- Tests ------------------------------------------------------------

// `export`-level purity check: the module must load under Node's
// CommonJS checker (no top-level browser globals referenced at import
// time). This file is exercised by scripts/test-pwa.js via the built
// bundle; the exports below are the page-facing surface.
export { refreshProjectsOnVisible as _refreshProjectsOnVisible };
