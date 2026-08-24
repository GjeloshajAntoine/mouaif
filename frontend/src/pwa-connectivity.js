// mouaif web — page connectivity state for the PWA shell.
//
// Native online/offline events cover device connectivity. The fetch wrapper
// also marks the app offline when a same-origin shell request cannot reach
// the server, while deliberately ignoring API, SSE, OAuth, and data routes.

import { signal } from '@preact/signals';

export const offline = signal(typeof navigator === 'undefined' ? false : !navigator.onLine);

let started = false;

function isAppShellUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    if (url.origin !== window.location.origin) return false;
    const path = url.pathname;
    if (path === '/api' || path.startsWith('/api/')) return false;
    if (path === '/events' || path.startsWith('/events/')) return false;
    if (path === '/data' || path.startsWith('/data/')) return false;
    if (path === '/oauth' || path.startsWith('/oauth/')) return false;
    if (path === '/favicon.ico') return false;
    return true;
  } catch { return false; }
}

function requestUrl(input) {
  try {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return String(input || '');
  } catch { return ''; }
}

export function startConnectivityTracking() {
  if (started || typeof window === 'undefined') return;
  started = true;

  const updateNativeState = () => { offline.value = !navigator.onLine; };
  window.addEventListener('online', updateNativeState);
  window.addEventListener('offline', updateNativeState);

  if (!window.fetch) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function trackedFetch(input, init) {
    const url = requestUrl(input);
    try {
      const response = await originalFetch(input, init);
      if (isAppShellUrl(url) && response && response.ok) offline.value = false;
      return response;
    } catch (error) {
      if (isAppShellUrl(url)) offline.value = true;
      throw error;
    }
  };
}
