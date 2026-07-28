// mouaif web entry. Built by Vite into /web/assets/index.js and
// served by the Node server at /web/.
//
// Architecture:
//   - One Preact tree, mounted into <main id="app"> from index.html.
//   - A small hash router (no history API; the Node server doesn't
//     rewrite unknown paths to index.html, so deep links would 404
//     anyway; the hash is enough for our views).
//   - Per-feature components live in src/web/src/components/,
//     imported below. Each file is one view or a small set of tightly
//     coupled views.

import { render, h } from 'preact';
import { App } from './components/App.jsx';
import { AccessGate } from './components/AccessAuth.jsx';
import { registerServiceWorker } from './sw-registration.js';
import { syncPushState } from './components/push.js';
import './style.css';
import './router.js';

// ---- Render ------------------------------------------------------------

const root = document.getElementById('app');
if (root) render(h(AccessGate, null, h(App, null)), root);

// Register the service worker (no-op in dev; see sw-registration.js
// for the production-only path). Deferred until after first paint so
// the SW install doesn't block the entry bundle download.
registerServiceWorker();

// Sync push notification state when the service worker is ready.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(() => syncPushState()).catch(() => {});
}