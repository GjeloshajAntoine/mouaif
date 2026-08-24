// mouaif web — service worker (precache the app shell, network-first
// for everything else).
//
// Build:
//   This file is the source. A small Vite plugin in vite.config.js
//   reads it, sets CACHE_VERSION to a content hash, and emits the
//   result as sw.js at the dist root. The Node server serves it at
//   /sw.js with Cache-Control: no-cache and
//   Service-Worker-Allowed: /.
//
// Strategy:
//   - install: precache the shell (index.html, manifest, icons).
//   - activate: delete any old mouaif-v* caches.
//   - fetch:
//       * same-origin GET under the app scope (/):
//           - navigation requests (HTML): network-first, fall back
//             to the cached shell so a cold offline launch still
//             renders the UI.
//           - static assets (CSS/JS/PNG/icons/webmanifest):
//             cache-first (they're fingerprinted, so cache hits
//             are always valid).
//       * anything else (cross-origin, /api/*, /events, /data, POST,
//         SSE, WebSocket): bypass the SW entirely. The chat UI is
//         fundamentally a live API surface; we cannot meaningfully
//         cache SSE streams or live HTML pages, and serving a stale
//         index.html from a previous version while the JS bundle
//         URL is new (or vice versa) was the original half-broken
//         UI bug.
//
// Scope:
//   The registration is `scope: '/'` (see main.jsx). The SW intercepts
//   same-origin GET requests under the root, so it must explicitly
//   bypass every non-PWA surface: /api/*, /events, /data, /oauth/*.
//   Those are checked in isShellAssetPath below.

/* eslint-disable no-restricted-globals */

const CACHE_VERSION = '__CACHE_VERSION__';
const CACHE_NAME = 'mouaif-v' + CACHE_VERSION;
const SHELL_CACHE = 'mouaif-shell-v' + CACHE_VERSION;

// Files to precache on install. The routes are absolute-from-root
// because the SW runs over the root scope. The hashed JS/CSS
// names aren't known at build time, so the precache list contains
// only the stable, unhashed shell entries (HTML, manifest, icons).
// Hashed assets are cached on first fetch via the cache-first
// branch of the fetch handler.
const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  // Precache the shell — best-effort. A failure on a single icon
  // (e.g. the user opened / once before icons were built) does
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
  // The SW scope is '/' (the whole origin), so be strict: intercept
  // only the mobile UI's static shell. Every live API surface is
  // signaled to fall through to the network untouched — /api/* (live
  // data, SSE), /events (SSE), /data (REST), /oauth/* (redirect
  // callbacks), and the favicon. Without this the root-scoped SW
  // would cache API responses as static assets and serve stale data.
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  if (pathname === '/events' || pathname.startsWith('/events')) return false;
  if (pathname === '/data' || pathname.startsWith('/data')) return false;
  if (pathname === '/oauth' || pathname.startsWith('/oauth/')) return false;
  if (pathname === '/favicon.ico') return false;
  return true;
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
      cache.put('/', fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match('/');
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

  // The SW scope is /, so be explicit — anything under
  // /api/, /events, /data, /oauth/ must reach the server
  // untouched. The same-origin check above already excludes
  // cross-origin traffic; this rule excludes any same-origin
  // endpoint that isn't a PWA asset.
  if (!isShellAssetPath(url.pathname)) return;

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirstNavigation(request));
  } else {
    event.respondWith(cacheFirstAsset(request));
  }
});

// ---- Page-reported visibility (notification suppression) -------------
//
// Suppressing an OS notification because "the user is already looking
// at this chat" cannot rely on WindowClient.focused / visibilityState
// alone: Safari (and the iOS PWA window in particular) reports stale or
// missing values through clients.matchAll(), which made notifications
// appear even while the chat was open on screen. The page itself always
// knows document.visibilityState exactly, so each controlled page keeps
// a persistent MessageChannel to the worker and reports { hash,
// visible, focused } on load, on visibilitychange/focus/blur, and on
// hashchange (see sw-registration.js — startVisibilityReporting). The
// push handler still makes a fresh request for every notification: cached
// reports and client properties only support bookkeeping and must never
// suppress an alert when a suspended page cannot answer.
const clientViews = new Map(); // clientId -> { hash, visible, focused, at }
const CLIENT_VIEW_TTL = 5 * 60 * 1000; // stale entries are ignored

function updateClientView(clientId, data) {
  if (!clientId) return;
  clientViews.set(clientId, {
    hash: typeof data.hash === 'string' ? data.hash : '',
    visible: data.visible === true,
    focused: data.focused === true,
    at: Date.now()
  });
  // Keep the map bounded: tabs that closed without a clean goodbye.
  for (const [id, view] of clientViews) {
    if (Date.now() - view.at > CLIENT_VIEW_TTL) clientViews.delete(id);
  }
}

function chatIdFromHash(hash) {
  const match = /^#\/chat\/([^/?#]+)/.exec(typeof hash === 'string' ? hash : '');
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}
function reportedViewMatchesChat(view, targetUrl) {
  if (!view || Date.now() - view.at > CLIENT_VIEW_TTL || !view.visible) return false;
  const reportedChatId = chatIdFromHash(view.hash);
  const targetChatId = chatIdFromHash(targetUrl.hash);
  return !!reportedChatId && reportedChatId === targetChatId;
}


const pendingViewQueries = new Map(); // queryId -> { clientId, finish(view) }
let viewQuerySequence = 0;

function queryClientView(client) {
  // Service workers are routinely suspended between events, clearing
  // clientViews. Ask each live page for fresh state when a push arrives
  // instead of treating that process-local cache as durable.
  return new Promise((resolve) => {
    if (!client || typeof client.postMessage !== 'function') {
      resolve(null);
      return;
    }
    const queryId = 'view-' + Date.now() + '-' + (++viewQuerySequence);
    const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
    let settled = false;
    const finish = (view) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingViewQueries.delete(queryId);
      try { if (channel) channel.port1.close(); } catch { /* best-effort */ }
      resolve(view && typeof view === 'object' ? { ...view, at: Date.now() } : null);
    };
    pendingViewQueries.set(queryId, { clientId: client.id || '', finish });
    const timer = setTimeout(() => finish(null), 1000);
    if (channel) {
      channel.port1.onmessage = (event) => finish(event.data);
      if (typeof channel.port1.start === 'function') channel.port1.start();
    }
    try {
      const message = { type: 'GET_VISIBILITY_STATE', queryId };
      if (channel) client.postMessage(message, [channel.port2]);
      else client.postMessage(message);
    } catch {
      // Some WebKit versions reject a transferred MessagePort even though
      // ordinary Client.postMessage works. Retry without transfer and let
      // VISIBILITY_STATE_RESPONSE resolve this query.
      try { client.postMessage({ type: 'GET_VISIBILITY_STATE', queryId }); }
      catch { finish(null); }
    }
  });
}

self.addEventListener('message', (event) => {
  // The page may post `{ type: 'SKIP_WAITING' }` after the user
  // accepts an "Update available — reload" prompt.
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // Persistent reporting channel (see sw-registration.js). The first
  // state snapshot arrives on the transferred port immediately, so a
  // push that lands right after page load is already suppressible.
  if (event.data && event.data.type === 'VISIBILITY_PORT' && event.ports && event.ports[0]) {
    // Key the persistent channel by the real client id (event.source.id)
    // when available, so the push handler can match the report against
    // the clients returned by clients.matchAll(). The page's random
    // clientId (sw-registration.js) is only a fallback for engines where
    // event.source is missing; a UUID that never equals client.id made
    // the page-reported "this chat is visible" state un-matchable on
    // Safari/iOS, so notifications appeared over an open chat.
    const clientId = (event.source && event.source.id) || event.data.clientId;
    const port = event.ports[0];
    port.onmessage = (msg) => {
      if (msg.data && msg.data.type === 'VISIBILITY_STATE') updateClientView(clientId, msg.data);
    };
    if (typeof port.start === 'function') port.start();
  }
  // One-shot state snapshot (fallback for engines without
  // navigator.serviceWorker.controller at registration time).
  if (event.data && event.data.type === 'VISIBILITY_STATE' && event.source && event.source.id) {
    updateClientView(event.source.id, event.data);
  }
  // iOS WebKit may drop the MessagePort transferred with a visibility
  // query. The page mirrors its answer as a regular service-worker message;
  // resolve the matching fresh query only when it came from that client.
  if (event.data && event.data.type === 'VISIBILITY_STATE_RESPONSE' && event.data.queryId) {
    const pending = pendingViewQueries.get(event.data.queryId);
    const sourceId = event.source && event.source.id ? event.source.id : '';
    if (pending && (!pending.clientId || pending.clientId === sourceId)) pending.finish(event.data.state);
  }
  // Navigate to a specific URL (e.g. deep link from notification click).
  // Clients that want to move an EXISTING app window (iOS PWA: no
  // WindowClient.navigate()) post the full target URL here; the page
  // swaps its own hash. This handler only opens a window when the
  // caller knows no client exists (notification click with no
  // matching window falls back to clients.openWindow itself).
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
    const freshViews = targetUrl ? await Promise.all(windows.map(queryClientView)) : [];
    freshViews.forEach((view, index) => {
      if (view) updateClientView(windows[index].id, view);
    });
    // Suppress only when a page answers this push-time query and confirms
    // that the target chat is visible. A suspended or recently closed PWA
    // can remain in clients.matchAll() with stale `focused: true` and a
    // stale cached visibility report while its JavaScript cannot answer.
    // Treating that stale state as visible intermittently discarded the
    // authorization push exactly when the app was no longer usable. If no
    // fresh answer arrives, showing the alert is the safe outcome.
    const chatVisible = !!targetUrl && freshViews.some((view) =>
      reportedViewMatchesChat(view, targetUrl));
const queued = await self.registration.getNotifications();
if (chatVisible) {
// Entering or staying in the target chat makes its queued alerts stale.
// Clear them as well as suppressing the incoming push so the tray does
// not keep showing notifications for content already on screen.
if (payload && payload.chatId) {
queued.forEach((notification) => {
if (notification.data && notification.data.chatId === payload.chatId) notification.close();
});
}
return;
}
const notifTag = tag || 'default';
// iOS can retain replaced notifications. Prune both the exact tag and
// every legacy status-slot tag for this chat before showing a progress,
// completion, or error update.
const statusKinds = new Set(['progress', 'completion', 'error']);
const incomingIsStatus = payload && statusKinds.has(payload.kind);
queued.forEach((notification) => {
const sameTag = notifTag !== 'default' && notification.tag === notifTag;
const sameStatusSlot = incomingIsStatus
&& notification.data
&& notification.data.chatId === payload.chatId
&& statusKinds.has(notification.data.kind);
if (sameTag || sameStatusSlot) notification.close();
});
    await self.registration.showNotification(title || 'mouaif', {
      body: body || '',
      tag: notifTag,
      renotify: renotify !== false,
      icon: icon || '/icons/icon-192.png',
      badge: badge || '/icons/favicon-32.png',
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
      ? '/#/chat/' + data.chatId + '?projectDir=' + encodeURIComponent(data.projectDir)
      : '/');
  const target = new URL(urlToOpen, self.location.origin);
  const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  // The client's URL always carries its *current* hash (never the one we
  // want to move to), so the match below must look at the pathname only —
  // comparing hashes here would miss every existing window and reopen the
  // app in a new tab on every click.
  const isAppWindow = (client) => {
    let url;
    try { url = new URL(client.url); } catch { return false; }
    return url.origin === self.location.origin && url.pathname === '/';
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
  // No matchable window: persist the click target BEFORE attempting to
  // open one. iOS PWA: when the app is closed or suspended, tapping the
  // notification relaunches the installed app at its start_url (/),
  // and clients.openWindow() is not supported there — the click would
  // land on the home screen. Writing the URL to IndexedDB lets the
  // freshly launched page consume it and navigate to the chat (see
  // frontend/src/sw-registration.js — consumePendingNotificationClick).
  await writeClickTarget(target.href);
  try {
    const opened = await clients.openWindow(target.href);
    // openWindow succeeded (desktop / non-iOS): the click landed in the
    // new window directly, so the stored target must not redirect a
    // later manual launch. iOS PWA throws here instead, leaving the
    // target for the freshly launched page to consume.
    await clearClickTarget();
    return opened;
  } catch {
    // Fall through; the launched page consumes the IndexedDB click target.
    return undefined;
  }
}

// ---- IndexedDB click-target handoff --------------------------------
//
// The service worker and the page share a tiny store of the most recent
// notification click URL. iOS PWA cannot rely on clients.openWindow()
// when the app is closed; the SW writes the URL here, the page reads
// and clears it on load (or on visibilitychange when the app comes
// back), and navigates if it points at a chat.
const CLICK_DB = 'mouaif-push-click';
const CLICK_STORE = 'clicks';
const CLICK_KEY = 'latest';

function clickDb() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error('no indexedDB'));
    const req = self.indexedDB.open(CLICK_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CLICK_STORE)) db.createObjectStore(CLICK_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
  });
}

function writeClickTarget(url) {
  return clickDb().then((db) => new Promise((resolve) => {
    const tx = db.transaction(CLICK_STORE, 'readwrite');
    tx.objectStore(CLICK_STORE).put({ url, at: Date.now() }, CLICK_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  })).catch(() => {});
}

function clearClickTarget() {
  return clickDb().then((db) => new Promise((resolve) => {
    const tx = db.transaction(CLICK_STORE, 'readwrite');
    tx.objectStore(CLICK_STORE).delete(CLICK_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  })).catch(() => {});
}

function readAndClearClickTarget() {
  return clickDb().then((db) => new Promise((resolve) => {
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
  })).catch(() => null);
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
