// mouaif web — service worker (precache the app shell, network-first
// for everything else).
//
// Build:
//   This file is the source. A small Vite plugin in vite.config.js
//   reads it, sets CACHE_VERSION to a content hash, and emits the
//   result as sw.js at the dist root. The Node server serves it at
//   /web/sw.js with Cache-Control: no-cache and
//   Service-Worker-Allowed: /web/.
//
// Strategy:
//   - install: precache the shell (index.html, manifest, icons).
//   - activate: delete any old mouaif-v* caches.
//   - fetch:
//       * same-origin GET under /web/:
//           - navigation requests (HTML): network-first, fall back
//             to the cached shell so a cold offline launch still
//             renders the UI.
//           - static assets (CSS/JS/PNG/icons/webmanifest):
//             cache-first (they're fingerprinted, so cache hits
//             are always valid).
//       * anything else (cross-origin, /api/*, /events, POST, SSE,
//         WebSocket): bypass the SW entirely. The chat UI is
//         fundamentally a live API surface; we cannot meaningfully
//         cache SSE streams or live HTML pages, and serving a stale
//         index.html from a previous version while the JS bundle
//         URL is new (or vice versa) was the original half-broken
//         UI bug.
//
// Scope:
//   The registration is `scope: '/web/'` (see main.jsx). The SW
//   only intercepts requests under that path; /api/* and /events
//   are untouched.

/* eslint-disable no-restricted-globals */

const CACHE_VERSION = '405b372f';
const CACHE_NAME = 'mouaif-v' + CACHE_VERSION;
const SHELL_CACHE = 'mouaif-shell-v' + CACHE_VERSION;

// Files to precache on install. The routes are absolute-from-root
// because the SW only runs over the /web/ scope. The hashed JS/CSS
// names aren't known at build time, so the precache list contains
// only the stable, unhashed shell entries (HTML, manifest, icons).
// Hashed assets are cached on first fetch via the cache-first
// branch of the fetch handler.
const SHELL_URLS = [
  '/web/',
  '/web/manifest.webmanifest',
  '/web/icons/icon-192.png',
  '/web/icons/icon-512.png',
  '/web/icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  // Precache the shell — best-effort. A failure on a single icon
  // (e.g. the user opened /web/ once before icons were built) does
  // not block activation: we still want to skip waiting so a new
  // version can take over without a force-reload.
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const results = await Promise.allSettled(SHELL_URLS.map((u) => cache.add(u)));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      // eslint-disable-next-line no-console
      console.warn('[mouaif-sw] precache partial:', failed.length, 'of', SHELL_URLS.length);
    }
    // Skip waiting so the new SW moves into clients immediately
    // after install. The page triggers clients.claim() in its
    // controllerchange handler so the new SW intercepts the very
    // next fetch without a full reload.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches that don't belong to the current build. The
    // include() check skips any SW-managed cache for a different
    // origin if a future feature grows one; today there's only one
    // mouaif prefix.
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k.startsWith('mouaif-') && k !== CACHE_NAME && k !== SHELL_CACHE) {
        return caches.delete(k);
      }
      return null;
    }));
    // Take control of every open client so the new version is live
    // without waiting for the user to navigate.
    await self.clients.claim();
  })());
});

function isShellAssetPath(pathname) {
  // Same-origin static asset: anything under /web/ that isn't an
  // API mount. /api/* (live data, SSE) is mounted at the root, so
  // its paths don't start with /web/ at all and fall through
  // without an event.respondWith() — the browser's network stack
  // handles them. The /web/api/ check is a defensive belt-and-
  // suspenders in case a future feature mounts an API under /web/.
  return pathname.startsWith('/web/') && !pathname.startsWith('/web/api/');
}

function isNavigationRequest(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.headers.get('accept') && request.headers.get('accept').includes('text/html'));
}

async function networkFirstNavigation(request) {
  // Try the network. If it responds (any 2xx/3xx), update the
  // shell cache and return the network response. If it fails
  // (offline, DNS error), fall back to the cached shell. The
  // fallback uses a fresh Request keyed at the root because the
  // original request may have included a query string we don't
  // care about for the offline shell.
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put('/web/', fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match('/web/');
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  // No cache hit. Fetch, then store on success so the next reload
  // is instant. Non-2xx responses are not cached; a 404 for a
  // missing icon shouldn't pollute the cache forever.
  const fresh = await fetch(request);
  if (fresh && fresh.ok) {
    cache.put(request, fresh.clone()).catch(() => {});
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // POST/PUT/DELETE/PATCH always hit the network
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // cross-origin: bypass

  // The SW scope is /web/, but be explicit — anything under
  // /api/, /events, /data, /oauth/ must reach the server
  // untouched. The same-origin check above already excludes
  // cross-origin traffic; this rule excludes any future same-
  // origin endpoint that isn't a PWA asset.
  if (!isShellAssetPath(url.pathname)) return;

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirstNavigation(request));
  } else {
    event.respondWith(cacheFirstAsset(request));
  }
});

self.addEventListener('message', (event) => {
  // The page may post `{ type: 'SKIP_WAITING' }` after the user
  // accepts an "Update available — reload" prompt.
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // Navigate to a specific URL (e.g. deep link from notification click).
  if (event.data && event.data.type === 'NAVIGATE' && event.data.url) {
    clients.openWindow(event.data.url);
  }
});

// ---- Push notifications ------------------------------------------------

self.addEventListener('push', (event) => {
  let data;
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const { title, body, tag, renotify, icon, badge, data: payload, actions, requireInteraction } = data;
  if (!title && !body) return;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const targetUrl = payload && payload.url ? new URL(payload.url, self.location.origin) : null;
    const chatVisible = windows.some((client) => {
      // Suppress only when the user is ACTUALLY looking at the app.
      // `client.focused` alone is not enough: on mobile (iOS PWA in
      // particular) a window can stay "focused" while the screen is
      // locked or another app is on top, which would hide the
      // notification the user should be seeing. `visibilityState`
      // (supported on Chromium WindowClients) is the authoritative
      // signal; when it's unavailable we fail OPEN (show the
      // notification) because suppression is only an optimization
      // and silently dropping an alert is the worse failure mode.
      if (!targetUrl) return false;
      try {
        if (client.visibilityState !== undefined && client.visibilityState !== 'visible') return false;
        if (client.visibilityState === undefined) return false; // no data: never suppress
        return client.focused && new URL(client.url).hash === targetUrl.hash;
      } catch { return false; }
    });
    if (chatVisible) return;
    const notifTag = tag || 'default';
    // showNotification with a matching tag replaces an existing
    // notification on every engine we support — except iOS Safari,
    // which keeps old notifications until the user acts on them. An
    // updatable progress alert would therefore stack a new alert on
    // top of every previous one on iPhone/iPad. Prune the same tag
    // from the OS queue ourselves before showing the new alert so
    // replace works there too.
    if (notifTag !== 'default') {
      const stale = await self.registration.getNotifications({ tag: notifTag });
      if (stale.length) stale.forEach((n) => n.close());
    }
    await self.registration.showNotification(title || 'mouaif', {
      body: body || '',
      tag: notifTag,
      renotify: renotify !== false,
      icon: icon || '/web/icons/icon-192.png',
      badge: badge || '/web/icons/favicon-32.png',
      data: payload || {},
      actions: actions || [{ action: 'open', title: 'Open chat' }],
      requireInteraction: requireInteraction === true,
      vibrate: requireInteraction === true ? [150, 80, 150] : [100]
    });
  })());
});

async function openNotificationTarget(data) {
  const urlToOpen = data.url
    || (data.chatId && data.projectDir
      ? '/web/#/chat/' + data.chatId + '?projectDir=' + encodeURIComponent(data.projectDir)
      : '/web/');
  const target = new URL(urlToOpen, self.location.origin);
  const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  // The client's URL always carries its *current* hash (never the one we
  // want to move to), so the match below must look at the pathname only —
  // comparing hashes here would miss every existing window and reopen the
  // app in a new tab on every click.
  const isAppWindow = (client) => {
    let url;
    try { url = new URL(client.url); } catch { return false; }
    return url.origin === self.location.origin && url.pathname.startsWith('/web/');
  };
  const appWindow = clientList.find(isAppWindow);
  if (appWindow && 'focus' in appWindow) {
    // iOS Safari does not support WindowClient.navigate(): posting the
    // target URL to the page is the only way to move an existing PWA
    // window there. The page swaps the hash (or reloads when it is
    // already there) and then focuses itself.
    appWindow.postMessage({ type: 'NAVIGATE', url: target.href });
    return appWindow.focus();
  }
  return clients.openWindow(target.href);
}

async function submitNotificationDecision(data, action) {
  if (!data.projectDir || !data.chatId || !data.callId) throw new Error('missing decision context');
  let decision = action;
  let payload;
  if (action.startsWith('answer-')) {
    const index = Number(action.slice('answer-'.length));
    const option = Array.isArray(data.options) ? data.options[index] : null;
    if (!option || !option.value) throw new Error('missing answer option');
    decision = 'allow-once';
    payload = { choice: option.value, extra: '' };
  }
  const response = await fetch('/api/tools/authorization/decision', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectDir: data.projectDir,
      chatId: data.chatId,
      callId: data.callId,
      decision,
      payload
    })
  });
  if (!response.ok) throw new Error('decision failed');
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  const action = event.action || 'open';
  if (action === 'open') event.waitUntil(openNotificationTarget(data));
  else event.waitUntil(submitNotificationDecision(data, action).catch(() => openNotificationTarget(data)));
});

self.addEventListener('notificationclose', (event) => {
  // Notification dismissed by user — could send a beacon for analytics
  // but is intentionally a no-op for now.
});
