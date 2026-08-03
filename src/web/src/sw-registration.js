// mouaif web — service worker registration and update flow.
//
// Scope: '/web/'. Anything outside the /web/ scope (API, SSE,
// OAuth callback, /data) is never intercepted; the SW explicitly
// bypasses non-/web/ traffic and non-GET requests.
//
// Update strategy:
//   - On every page load, register /web/sw.js.
//   - If a new SW is found (updateAvailable signal fires), show
//     the "Update available — reload" banner.
//   - The user is in control: we only call skipWaiting() once they
//     accept, then a full reload picks up the new bundle. This
//     avoids the half-loaded "old HTML + new JS" state.
//
// Offline signal:
//   - Maintain an offline signal the UI can subscribe to. It's
   `true`
//     whenever the last same-origin /web/ fetch failed (network-
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

function sameOriginAppPath(url) {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin && u.pathname.startsWith('/web/');
  } catch { return false; }
}

function trackOnlineStatus() {
  const set = () => { offline.value = !navigator.onLine; };
  window.addEventListener('online', set);
  window.addEventListener('offline', set);
}

// Wrap fetch so a same-origin /web/ fetch failure flips the offline
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
    if (msg.type === 'NAVIGATE' && msg.url) {
      const url = new URL(msg.url, window.location.origin);
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/web/')) return;
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
    navigator.serviceWorker.register('/web/sw.js', { scope: '/web/' })
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

// ---- Tests ------------------------------------------------------------

// `export`-level purity check: the module must load under Node's
// CommonJS checker (no top-level browser globals referenced at import
// time). This file is exercised by scripts/test-pwa.js via the built
// bundle; the exports below are the page-facing surface.
export { refreshProjectsOnVisible as _refreshProjectsOnVisible };
