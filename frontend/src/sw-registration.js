// mouaif web — service-worker registration and update lifecycle.
//
// Runtime push messaging, connectivity tracking, and notification-click
// routing live in focused modules. This file only registers /sw.js, exposes
// update availability, and applies an update after the user taps Reload.

import { signal } from '@preact/signals';

export const updateAvailable = signal(false);
let registration = null;
let waitingWorker = null;
let applyingUpdate = false;
const observedWorkers = new WeakSet();
const UPDATE_CHECK_INTERVAL_MS = 60 * 1000;

function isProduction() {
  try { return !!import.meta.env && import.meta.env.PROD === true; }
  catch { return false; }
}

function markWaiting(reg, worker = reg.waiting) {
  registration = reg;
  waitingWorker = worker;
  updateAvailable.value = true;
}

function observeInstallingWorker(reg, worker) {
  if (!worker || observedWorkers.has(worker)) return;
  observedWorkers.add(worker);

  const onStateChange = () => {
    if (worker.state !== 'installed') return;
    if (navigator.serviceWorker.controller) markWaiting(reg, worker);
    else worker.postMessage({ type: 'SKIP_WAITING' }); // first install has no old bundle to protect
  };
  worker.addEventListener('statechange', onStateChange);

  // Registration can resolve after the browser has already started—or even
  // finished—the update check. Inspect the current state so that update is not
  // missed until the next navigation.
  onStateChange();
}

export function applyUpdate() {
  const worker = (registration && registration.waiting) || waitingWorker;
  if (applyingUpdate || !worker) return;
  applyingUpdate = true;
  worker.postMessage({ type: 'SKIP_WAITING' });
}

export function registerServiceWorker() {
  if (!isProduction() || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const schedule = (callback) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(callback, { timeout: 2500 });
    else setTimeout(callback, 1500);
  };

  schedule(() => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((reg) => {
        registration = reg;
        if (reg.waiting && reg.active) markWaiting(reg);
        observeInstallingWorker(reg, reg.installing);
        reg.addEventListener('updatefound', () => {
          observeInstallingWorker(reg, reg.installing);
        });

        // Do not rely only on the browser's registration-time update check.
        // WebKit may finish it before updatefound is attached, leaving the
        // waiting worker invisible until the page is manually reloaded.
        reg.update().then(() => {
          if (reg.waiting && reg.active) markWaiting(reg);
          observeInstallingWorker(reg, reg.installing);
        }).catch(() => {});

        const checkForUpdate = () => reg.update().catch(() => {});
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') checkForUpdate();
        });

        // A standalone PWA can remain foregrounded for hours, so
        // visibilitychange alone is insufficient. Poll only while visible;
        // update() is a no-op when the no-cache worker bytes are unchanged.
        setInterval(() => {
          if (document.visibilityState === 'visible') checkForUpdate();
        }, UPDATE_CHECK_INTERVAL_MS);
      })
      .catch(() => {
        // Registration is an enhancement. The live app remains usable when
        // private mode or browser policy disables service workers.
      });
  });

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
