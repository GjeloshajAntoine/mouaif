// mouaif web — page-side bridge for push notifications.
//
// The service worker asks for fresh visibility before showing each push.
// A transferred MessagePort is preferred; a query-ID-correlated regular
// message is sent too because iOS WebKit can silently drop the port.

import { clearStoredClickTarget, navigateToNotificationTarget } from './notification-click.js';

let started = false;

function visibilitySnapshot() {
  return {
    type: 'VISIBILITY_STATE',
    hash: window.location.hash || '',
    visible: document.visibilityState === 'visible',
    focused: typeof document.hasFocus === 'function' ? document.hasFocus() : false
  };
}

function replyWithVisibility(event, message) {
  const state = visibilitySnapshot();
  if (event.ports && event.ports[0]) {
    try { event.ports[0].postMessage(state); } catch { /* use plain reply */ }
  }
  if (!message.queryId) return;

  try {
    const worker = event.source && typeof event.source.postMessage === 'function'
      ? event.source
      : navigator.serviceWorker.controller;
    if (worker) worker.postMessage({
      type: 'VISIBILITY_STATE_RESPONSE',
      queryId: message.queryId,
      state
    });
  } catch { /* worker timeout deliberately shows the notification */ }
}

export function startPushPageBridge() {
  if (started || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  started = true;

  navigator.serviceWorker.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'GET_VISIBILITY_STATE') {
      replyWithVisibility(event, message);
      return;
    }
    if (message.type === 'NAVIGATE' && message.url) {
      navigateToNotificationTarget(message.url);
      clearStoredClickTarget();
    }
  });
}

export function refreshProjectsOnVisible() {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const hash = window.location.hash || '';
    if (hash.startsWith('#/chat') || hash.startsWith('#/settings')) return;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}
