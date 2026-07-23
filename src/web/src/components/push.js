// mouaif web — Push notification manager
//
// Handles the browser Push API lifecycle: permission request,
// subscription, unsubscription, and state tracking via signals.

import { signal } from '@preact/signals';
import { fetchJson } from '../api.js';

export const pushSupported = signal(typeof window !== 'undefined' && 'Notification' in window && 'PushManager' in window);
export const pushPermission = signal(typeof window !== 'undefined' ? Notification.permission : 'denied');
export const pushEnabled = signal(false); // whether we have a registered subscription
export const pageVisible = signal(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true);

let _registration = null;
let _subscription = null;

// Track page visibility — push notifications are less useful when the
// user is already looking at the app.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    pageVisible.value = document.visibilityState === 'visible';
  });
  window.addEventListener('focus', () => { pageVisible.value = true; });
  window.addEventListener('blur', () => { pageVisible.value = false; });
}

// Check and sync the current subscription state with the server.
export async function syncPushState() {
  if (!pushSupported.value) return false;
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    _registration = reg;
    const sub = await reg.pushManager.getSubscription();
    _subscription = sub;
    pushEnabled.value = !!sub;

    if (sub) {
      // Verify subscription is still valid by listing from server
      const r = await fetchJson('/api/push/subscriptions');
      pushEnabled.value = r.status === 200 && Array.isArray(r.body.subscriptions) && r.body.subscriptions.length > 0;
    }

    pushPermission.value = Notification.permission;
    return pushEnabled.value;
  } catch {
    return false;
  }
}

// Request notification permission and subscribe for push.
// Returns true if subscribed, false otherwise.
export async function requestPushPermission() {
  if (!pushSupported.value) return false;

  try {
    const perm = await Notification.requestPermission();
    pushPermission.value = perm;
    if (perm !== 'granted') return false;

    // Already subscribed? Sync.
    if (pushEnabled.value) return true;

    // Fetch VAPID public key from server
    const keyRes = await fetchJson('/api/push/vapid-public-key');
    if (keyRes.status !== 200) return false;

    const vapidPublicKey = keyRes.body.publicKey;
    const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);

    const reg = await navigator.serviceWorker.ready;
    _registration = reg;

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
    _subscription = sub;

    // Send subscription to server
    const subData = sub.toJSON();
    const r = await fetchJson('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: subData.endpoint,
          keys: subData.keys
        }
      })
    });

    if (r.status === 200) {
      pushEnabled.value = true;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Unsubscribe and remove subscription from server.
export async function unsubscribePush() {
  if (!pushSupported.value || !_subscription) return;

  try {
    const endpoint = _subscription.endpoint;
    await _subscription.unsubscribe();
    _subscription = null;
    pushEnabled.value = false;

    // Remove from server
    await fetchJson('/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint })
    });
  } catch {
    // Best-effort
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