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
    // Stay in the waiting state until the user accepts the page's update
    // banner. This avoids activating a new worker under an old JS bundle.
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

// ---- Fresh page visibility (notification suppression) -----------------
//
// WindowClient.focused / visibilityState are stale on Safari and iOS PWA.
// Query live pages when a chat push arrives and suppress only when a page
// answers that the target chat is currently visible (and, for questions and
// approvals, focused). No cached view state is trusted.

function chatIdFromHash(hash) {
  const match = /^#\/chat\/([^/?#]+)/.exec(typeof hash === 'string' ? hash : '');
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}
function reportedViewMatchesChat(view, targetUrl) {
  if (!view || !view.visible) return false;
  const reportedChatId = chatIdFromHash(view.hash);
  const targetChatId = chatIdFromHash(targetUrl.hash);
  return !!reportedChatId && reportedChatId === targetChatId;
}


const pendingViewQueries = new Map(); // queryId -> { clientId, finish(view) }
let viewQuerySequence = 0;

function queryClientView(client) {
  // Ask each live page for fresh state when a push arrives. A page that
  // cannot answer within the deadline is treated as hidden/suspended.
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

// ---- Notification icons ------------------------------------------------
//
// Each notification type gets its own icon, drawn here at push time rather
// than shipped as static files, so it can follow the notification's live
// state: a progress update draws a ring filled to its current percentage, and
// a failed operation turns red. `icon` is the large colour image; `badge` is
// the small monochrome status-bar glyph Android masks by alpha.
//
// Drawing needs OffscreenCanvas in the worker (Chrome, Edge, Firefox,
// Safari 16.4+). Without it, or on any drawing error, the notification keeps
// the app icon. iOS shows the app icon regardless of what is passed.
const NOTIFICATION_ICON_STYLES = {
  progress: { color: '#2563eb', glyph: 'ring' },
  completion: { color: '#16a34a', glyph: 'check' },
  error: { color: '#dc2626', glyph: 'cross' },
  ask_user: { color: '#7c3aed', glyph: 'question' },
  tool_authorization: { color: '#d97706', glyph: 'lock' },
  login: { color: '#0d9488', glyph: 'person' },
  run: { color: '#4f46e5', glyph: 'play' },
  test: { color: '#db2777', glyph: 'bell' }
};
const NOTIFICATION_ICON_SIZE = 192;
const NOTIFICATION_BADGE_SIZE = 96;
const notificationIconCache = new Map();

// notificationIconSpec(payload) -> { kind, color, glyph, percent } | null.
// A failed progress update reads as an error; an unknown kind gets null so
// the caller keeps the app icon.
function notificationIconSpec(payload) {
  const data = payload || {};
  const failed = data.kind === 'progress' && data.failed === true;
  const kind = failed ? 'error' : data.kind;
  const style = NOTIFICATION_ICON_STYLES[kind];
  if (!style) return null;
  const raw = Number(data.progress);
  const percent = style.glyph === 'ring' && data.progress != null && isFinite(raw)
    ? Math.max(0, Math.min(100, Math.round(raw)))
    : null;
  return { kind, color: style.color, glyph: style.glyph, percent };
}

// drawNotificationGlyph(ctx, spec, size, mono) — paint one glyph in unit
// coordinates. `mono` draws white on transparent (badge); otherwise a
// coloured disc carries a white glyph.
function drawNotificationGlyph(ctx, spec, size, mono) {
  const s = size;
  const ink = '#ffffff';
  ctx.clearRect(0, 0, s, s);
  if (!mono) {
    ctx.fillStyle = spec.color;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = s * (mono ? 0.12 : 0.09);
  const line = (points) => {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
    ctx.stroke();
  };
  switch (spec.glyph) {
    case 'ring': {
      const radius = s * (mono ? 0.36 : 0.32);
      const share = spec.percent == null ? 0.25 : spec.percent / 100;
      ctx.lineWidth = s * (mono ? 0.14 : 0.08);
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (share > 0) {
        ctx.beginPath();
        ctx.arc(s / 2, s / 2, radius, -Math.PI / 2, -Math.PI / 2 + share * Math.PI * 2);
        ctx.stroke();
      }
      if (!mono && spec.percent != null) {
        // The number sits inside the ring; shrink it until it fits.
        const label = spec.percent + '%';
        let fontSize = s * 0.21;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        do {
          ctx.font = '700 ' + Math.round(fontSize) + 'px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
          fontSize -= 2;
        } while (ctx.measureText(label).width > radius * 1.5 && fontSize > s * 0.1);
        ctx.fillText(label, s / 2, s / 2 + s * 0.01);
      }
      break;
    }
    case 'check':
      line([[0.3, 0.52], [0.44, 0.66], [0.71, 0.37]]);
      break;
    case 'cross':
      line([[0.35, 0.35], [0.65, 0.65]]);
      line([[0.65, 0.35], [0.35, 0.65]]);
      break;
    case 'question':
      ctx.beginPath();
      ctx.arc(0.5 * s, 0.39 * s, 0.13 * s, Math.PI, Math.PI * 2.3);
      ctx.lineTo(0.5 * s, 0.58 * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0.5 * s, 0.72 * s, s * 0.055, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'lock': {
      ctx.lineWidth = s * (mono ? 0.1 : 0.075);
      ctx.beginPath();
      ctx.moveTo(0.38 * s, 0.5 * s);
      ctx.lineTo(0.38 * s, 0.42 * s);
      ctx.arc(0.5 * s, 0.42 * s, 0.12 * s, Math.PI, Math.PI * 2);
      ctx.lineTo(0.62 * s, 0.5 * s);
      ctx.stroke();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(0.29 * s, 0.48 * s, 0.42 * s, 0.3 * s, 0.05 * s);
      else ctx.rect(0.29 * s, 0.48 * s, 0.42 * s, 0.3 * s);
      ctx.fill();
      // Keyhole: punched through so the disc (or transparency) shows.
      ctx.save();
      ctx.globalCompositeOperation = mono ? 'destination-out' : 'source-over';
      ctx.fillStyle = mono ? '#000000' : spec.color;
      ctx.beginPath();
      ctx.arc(0.5 * s, 0.61 * s, 0.045 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'person':
      ctx.beginPath();
      ctx.arc(0.5 * s, 0.38 * s, 0.12 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0.5 * s, 0.78 * s, 0.22 * s, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      break;
    case 'play':
      ctx.lineWidth = s * 0.06;
      ctx.beginPath();
      ctx.moveTo(0.41 * s, 0.32 * s);
      ctx.lineTo(0.7 * s, 0.5 * s);
      ctx.lineTo(0.41 * s, 0.68 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    case 'bell':
      ctx.beginPath();
      ctx.moveTo(0.29 * s, 0.65 * s);
      ctx.lineTo(0.71 * s, 0.65 * s);
      ctx.lineTo(0.65 * s, 0.56 * s);
      ctx.lineTo(0.65 * s, 0.46 * s);
      ctx.arc(0.5 * s, 0.46 * s, 0.15 * s, 0, Math.PI, true);
      ctx.lineTo(0.35 * s, 0.56 * s);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0.5 * s, 0.71 * s, 0.055 * s, 0, Math.PI * 2);
      ctx.fill();
      break;
    default:
      break;
  }
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(binary);
}

async function renderNotificationImage(spec, size, mono) {
  const key = [spec.kind, spec.percent, size, mono ? 'mono' : 'colour'].join('|');
  if (notificationIconCache.has(key)) return notificationIconCache.get(key);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  drawNotificationGlyph(ctx, spec, size, mono);
  const url = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
  // Progress can produce up to 101 ring images per kind; keep the cache small.
  if (notificationIconCache.size > 64) notificationIconCache.clear();
  notificationIconCache.set(key, url);
  return url;
}

// notificationIconFor(payload) -> { icon, badge } drawn for this type and
// state, or {} when the type is unknown or the worker cannot draw.
async function notificationIconFor(payload) {
  const spec = notificationIconSpec(payload);
  if (!spec || typeof OffscreenCanvas !== 'function') return {};
  try {
    const [icon, badge] = await Promise.all([
      renderNotificationImage(spec, NOTIFICATION_ICON_SIZE, false),
      renderNotificationImage(spec, NOTIFICATION_BADGE_SIZE, true)
    ]);
    return { icon: icon || undefined, badge: badge || undefined };
  } catch {
    return {};
  }
}

// ---- Push notifications ------------------------------------------------

self.addEventListener('push', (event) => {
  let data;
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const { title, body, tag, renotify, icon, badge, data: payload, actions, requireInteraction } = data;
  if (!title && !body) return;

  event.waitUntil((async () => {
    const statusKinds = new Set(['progress', 'completion', 'error']);
    const authorizationKinds = new Set(['ask_user', 'tool_authorization']);
    const incomingIsStatus = payload && statusKinds.has(payload.kind);
    const incomingIsAuthorization = payload && authorizationKinds.has(payload.kind);
    const targetUrl = payload && payload.url ? new URL(payload.url, self.location.origin) : null;
    const windows = targetUrl
    ? await clients.matchAll({ type: 'window', includeUncontrolled: true }) : [];
    const freshViews = targetUrl ? await Promise.all(windows.map(queryClientView)) : [];
    // Suppress only on a fresh visible-chat response. A suspended PWA may
    // have stale WindowClient state but cannot answer this query; no
    // response means the notification still gets shown. Questions and
    // approvals additionally need the page focused: a visible but
    // unfocused desktop window does not mean the user sees the card.
    const chatVisible = !!targetUrl && freshViews.some((view) =>
      reportedViewMatchesChat(view, targetUrl)
      && (!incomingIsAuthorization || view.focused === true));
const queued = await self.registration.getNotifications();
if (chatVisible) {
// The chat is on screen, so older alerts in the same slot are stale. A
// status update must never dismiss an unanswered question or approval.
const slotKinds = incomingIsAuthorization ? authorizationKinds : statusKinds;
if (payload && payload.chatId) {
queued.forEach((notification) => {
if (notification.data && notification.data.chatId === payload.chatId
&& slotKinds.has(notification.data.kind)) notification.close();
});
}
return;
}
const notifTag = tag || 'default';
// iOS can retain replaced notifications. Prune both the exact tag and
// every legacy status-slot tag for this chat before showing a progress,
// completion, or error update.
queued.forEach((notification) => {
const sameTag = notifTag !== 'default' && notification.tag === notifTag;
const sameChat = notification.data && payload
&& notification.data.chatId === payload.chatId;
const sameStatusSlot = incomingIsStatus && sameChat
&& statusKinds.has(notification.data.kind);
const sameAuthorizationSlot = incomingIsAuthorization && sameChat
&& authorizationKinds.has(notification.data.kind);
if (sameTag || sameStatusSlot || sameAuthorizationSlot) notification.close();
});
    // An explicit server icon wins; otherwise draw one for this type and state.
    const drawn = icon && badge ? {} : await notificationIconFor(payload);
    await self.registration.showNotification(title || 'mouaif', {
      body: body || '',
      tag: notifTag,
      renotify: renotify !== false,
      icon: icon || drawn.icon || '/icons/icon-192.png',
      badge: badge || drawn.badge || '/icons/favicon-32.png',
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
    //
    // Persist the click target as a fallback BEFORE posting the message.
    // A suspended iOS PWA can be woken by focus without its JS running to
    // receive the NAVIGATE postMessage (WebKit drops it), and the app then
    // reopens at start_url instead of the clicked chat. Writing the same
    // target the cold-launch path uses lets the woken page consume it on
    // load / focus / visible and recover the navigation. The page clears
    // the store once a NAVIGATE is actually handled, so a successful move
    // never re-triggers.
    await writeClickTarget(target.href);
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
// openWindow succeeded (desktop / non-iOS). Only clear the stored
// target when the new window actually loaded the clicked chat URL —
// compare the hash, since the window's URL always carries its current
// hash and that is the only thing we need to match. iOS can resolve
// openWindow() WITHOUT navigating to the clicked URL (it may reopen
// start_url / instead), so clearing here on a non-match would discard
// the only navigation hint and drop the user on the chats list. A
// non-matching window keeps the target; the freshly loaded page's
// consumePendingNotificationClick() then recovers it. Keeping it on
// desktop when the URLs do match is impossible, so this is safe.
const openedUrl = (opened && typeof opened.url === 'string')
? new URL(opened.url, self.location.origin) : null;
if (openedUrl && openedUrl.hash === target.hash) await clearClickTarget();
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
