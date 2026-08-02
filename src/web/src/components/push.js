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

async function registerSubscription(sub) {
  const subData = sub && sub.toJSON ? sub.toJSON() : null;
  if (!subData || !subData.endpoint || !subData.keys || !subData.keys.p256dh || !subData.keys.auth) return false;
  const r = await fetchJson('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: { endpoint: subData.endpoint, keys: subData.keys }
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