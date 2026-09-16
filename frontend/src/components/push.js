// mouaif web — Push notification manager
//
// Handles the browser Push API lifecycle: permission request,
// subscription, unsubscription, and state tracking via signals.

import { signal } from '@preact/signals';
import { fetchJson } from '../api.js';

// The service worker is intentionally production-only. Treat Push as
// unsupported in Vite dev mode rather than waiting forever on
// navigator.serviceWorker.ready when no worker will be registered.
const productionBuild = !!import.meta.env && import.meta.env.PROD === true;
export const pushSupported = signal(productionBuild && typeof window !== 'undefined' && 'Notification' in window && 'PushManager' in window && !!navigator.serviceWorker);
export const pushPermission = signal(typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'denied');
export const pushEnabled = signal(false); // whether we have a registered subscription

let _registration = null;
let _subscription = null;

// withTimeout(promise, ms, label) — resolve with null if the promise does not
// settle in time. The browser permission prompt and `serviceWorker.ready`
// can both hang forever (headless Chrome shows no prompt, some browsers
// defer the prompt until the user interacts with a page element, and a
// failed SW install never resolves `ready`). Without a deadline the
// settings screen would stay stuck on `busy` with every control disabled.
function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn('[mouaif-push] ' + label + ' timed out after ' + ms + 'ms');
      resolve(null);
    }, ms);
    Promise.resolve(promise).then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } }
    );
  });
}

// How long to wait for the OS permission prompt. A real prompt resolves in
// seconds; this only trips when the browser never shows one.
const PERMISSION_PROMPT_TIMEOUT_MS = 30_000;
// How long to wait for the service worker to reach the active state.
const SW_READY_TIMEOUT_MS = 10_000;
// Fallback body width when the DOM cannot be measured (a headless browser, a
// worker-only context): the phone row the ASCII status bar was designed for.
const DEFAULT_STATUS_BAR_MAX_CHARS = 32;

// ---- Device report for status-bar sizing -------------------------------
//
// The server renders the ASCII status bar at a cell count derived from the
// receiving device, and needs three facts about it: how wide one notification
// body line is, which OS (and version) presents the notification, and whether
// it presents collapsed or expanded. Everything here is a raw measurement or
// a literal platform string — the sizing rules live server-side in
// src/statusBar.js, so there is one table to reason about and one place to
// change when a platform shifts its notification style.

// osFromUserAgent(ua) -> { os, osVersion }
//
// Fallback platform detection for browsers without `navigator.userAgentData`.
// Only the OS is read — the notification style does not vary by browser — and
// the version is the major number, which is all the server's version table
// keys on. iPadOS reports "Macintosh" in its UA, so the modern iPad case is
// detected by touch points and sent as 'ipados'.
function osFromUserAgent() {
  if (typeof navigator === 'undefined') return { os: '', osVersion: 0 };
  const ua = String(navigator.userAgent || '');
  const maxTouch = Number(navigator.maxTouchPoints) || 0;
  if (/iPhone|iPod/.test(ua)) {
    const m = ua.match(/OS (\d+)[._]/);
    return { os: 'ios', osVersion: m ? Number(m[1]) : 0 };
  }
  if (/iPad/.test(ua)) {
    const m = ua.match(/OS (\d+)[._]/);
    return { os: 'ios', osVersion: m ? Number(m[1]) : 0 };
  }
  // Desktop-class Safari on a touch device is an iPad running iPadOS 13+.
  if (/Macintosh/.test(ua) && maxTouch > 1) return { os: 'ipados', osVersion: 0 };
  let m = ua.match(/Android (\d+)/);
  if (m) return { os: 'android', osVersion: Number(m[1]) };
  m = ua.match(/Mac OS X (\d+)[._]/);
  if (m) return { os: 'macos', osVersion: Number(m[1]) };
  m = ua.match(/Windows NT (\d+)/);
  if (m) return { os: 'windows', osVersion: Number(m[1]) };
  m = ua.match(/CrOS \S+ (\d+)/);
  if (m) return { os: 'chromeos', osVersion: Number(m[1]) };
  if (/Linux/.test(ua)) return { os: 'linux', osVersion: 0 };
  return { os: '', osVersion: 0 };
}

// notificationStyle() -> 'collapsed' | 'expanded'
//
// How the OS presents this notification before the user expands it. 'collapsed'
// is the honest default for every surface a browser can be running on — a
// phone banner, a desktop toast, and a desktop-centre popup all preview their
// body — and the server then turns that into a line count for the reported OS
// and version. A full-screen (kiosk) install is the one case with room to
// spare, so it is reported as expanded. A plain browser tab is not a
// notification surface and keeps the default.
function notificationStyle() {
  try {
    if (typeof matchMedia === 'function' && matchMedia('(display-mode: fullscreen)').matches) return 'expanded';
  } catch { /* keep the default */ }
  return 'collapsed';
}

// deviceReport() -> { chars, viewportWidth, os, osVersion, style }
//
// `chars` is measured, not guessed: a hidden element styled with the
// monospace metrics a notification preview uses is laid out in the viewport
// and its per-character width counted, so the number tracks every phone size
// and grows with a desktop window — no user-agent sniffing for width.
//
// `style` is the notification presentation (`notificationStyle()`), `os`/`osVersion` the platform
// facts the server's line-count and fallback table keys on.
function deviceReport() {
  const report = {
    chars: DEFAULT_STATUS_BAR_MAX_CHARS,
    viewportWidth: 0,
    os: '',
    osVersion: 0,
    style: notificationStyle()
  };
  try {
    if (typeof window !== 'undefined') {
      report.viewportWidth = Math.round((window.visualViewport && window.visualViewport.width) || window.innerWidth || 0);
    }
    if (typeof document !== 'undefined' && document.body) {
      const probe = document.createElement('span');
      probe.textContent = '0'.repeat(200);
      probe.setAttribute('aria-hidden', 'true');
      // Monospace at the size a notification previews its body. The OS's own
      // notification font is not the page font, so a proportional fallback is
      // fine — the server bands the value and only needs a good estimate.
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;'
        + 'white-space:nowrap;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;';
      document.body.appendChild(probe);
      const charWidth = probe.getBoundingClientRect().width / 200;
      probe.remove();
      const viewport = report.viewportWidth;
      if (charWidth > 0 && Number.isFinite(charWidth) && viewport > 0) {
        // The OS wraps the body to the notification card, which is narrower
        // than the viewport (margins plus the app icon/badge gutter). 0.92 is
        // a conservative fit so a measured bar never overflows the card.
        const chars = Math.floor((viewport * 0.92) / charWidth);
        if (chars > 0) report.chars = chars;
      }
    }
    // `navigator.userAgentData` is the accurate, structured source where it
    // exists (Chromium); the UA string covers Safari and the rest.
    const uaData = typeof navigator !== 'undefined' ? navigator.userAgentData : null;
    if (uaData && typeof uaData.platform === 'string' && uaData.platform) {
      report.os = uaData.platform;
      const major = uaData.platformVersion ? Number(String(uaData.platformVersion).split('.')[0]) : 0;
      report.osVersion = Number.isFinite(major) ? major : 0;
    } else {
      const detected = osFromUserAgent();
      report.os = detected.os;
      report.osVersion = detected.osVersion;
    }
  } catch { /* keep the conservative defaults */ }
  return report;
}

async function registerSubscription(sub) {
  const subData = sub && sub.toJSON ? sub.toJSON() : null;
  if (!subData || !subData.endpoint || !subData.keys || !subData.keys.p256dh || !subData.keys.auth) return false;
  const report = deviceReport();
  const r = await fetchJson('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: {
        endpoint: subData.endpoint,
        keys: subData.keys,
        // Both shapes are sent: `statusBarProfile` carries the full device
        // report, `statusBarMaxChars` keeps a server that only knows the older
        // shape sizing correctly during a rolling update.
        statusBarMaxChars: report.chars,
        statusBarProfile: report
      }
    })
  });
  return r.status === 200;
}

// Check and sync the current subscription state with the server.
export async function syncPushState() {
  if (!pushSupported.value) return false;
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return false;

  try {
    pushPermission.value = Notification.permission;
    const reg = await withTimeout(navigator.serviceWorker.ready, SW_READY_TIMEOUT_MS, 'serviceWorker.ready (sync)');
    if (!reg) return false;
    _registration = reg;
    const sub = await reg.pushManager.getSubscription();
    _subscription = sub;
    pushEnabled.value = !!sub;

    if (sub) {
      // Rebind a valid local subscription to the fresh browser session after
      // a server restart. The Push endpoint remains valid while the HttpOnly
      // mouaif session cookie is intentionally ephemeral.
      const r = await fetchJson('/api/push/subscriptions');
      const rows = r.status === 200 && r.body && Array.isArray(r.body.subscriptions) ? r.body.subscriptions : [];
      pushEnabled.value = rows.some(x => x && x.endpoint === sub.endpoint);
      if (!pushEnabled.value) {
        pushEnabled.value = await registerSubscription(sub);
      }
    }

    return pushEnabled.value;
  } catch {
    pushEnabled.value = false;
    return false;
  }
}

// Request notification permission and subscribe for push.
// Returns true if subscribed, false otherwise.
export async function requestPushPermission() {
  if (!pushSupported.value) return false;

  try {
    const perm = await withTimeout(Notification.requestPermission(), PERMISSION_PROMPT_TIMEOUT_MS, 'Notification.requestPermission');
    if (perm !== 'granted') {
      pushPermission.value = Notification.permission;
      return false;
    }
    pushPermission.value = 'granted';

    // Already subscribed? Make sure the server still has this endpoint.
    if (pushEnabled.value && await syncPushState()) return true;

    // Fetch VAPID public key from server
    const keyRes = await fetchJson('/api/push/vapid-public-key');
    if (keyRes.status !== 200) return false;

    const vapidPublicKey = keyRes.body.publicKey;
    const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);

    const reg = await withTimeout(navigator.serviceWorker.ready, SW_READY_TIMEOUT_MS, 'serviceWorker.ready (subscribe)');
    if (!reg) return false;
    _registration = reg;

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
    _subscription = sub;

    if (!await registerSubscription(sub)) {
      try { await sub.unsubscribe(); } catch { /* best-effort cleanup */ }
      _subscription = null;
      pushEnabled.value = false;
      return false;
    }
    pushEnabled.value = true;
    return true;
  } catch {
    pushEnabled.value = false;
    return false;
  }
}

// Unsubscribe and remove subscription from server.
export async function unsubscribePush() {
  if (!pushSupported.value) return;

  try {
    if (!_subscription && _registration) {
      _subscription = await _registration.pushManager.getSubscription();
    }
    if (!_subscription && typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const reg = await withTimeout(navigator.serviceWorker.ready, SW_READY_TIMEOUT_MS, 'serviceWorker.ready (unsubscribe)');
      if (!reg) {
        pushEnabled.value = false;
        return;
      }
      _registration = reg;
      _subscription = await reg.pushManager.getSubscription();
    }
    if (!_subscription) {
      pushEnabled.value = false;
      return;
    }

    const endpoint = _subscription.endpoint;
    try { await _subscription.unsubscribe(); } catch { /* best-effort */ }
    _subscription = null;
    pushEnabled.value = false;

    // Remove from server
    await fetchJson('/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint })
    });
  } catch {
    pushEnabled.value = false;
  }
}

// Helper: convert base64url string to Uint8Array for applicationServerKey
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}