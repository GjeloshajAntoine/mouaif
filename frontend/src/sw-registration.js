// mouaif web — service-worker registration and update lifecycle.
//
// Runtime push messaging, connectivity tracking, and notification-click
// routing live in focused modules. This file only registers /sw.js, exposes
// update availability, and applies an update after the user taps Reload.

import { signal } from '@preact/signals';
import { shouldReloadOnControllerChange, isUpdateStillPending } from './sw-controller-reload.js';
export const updateAvailable = signal(false);
let registration = null;
let waitingWorker = null;
let applyingUpdate = false;
// Set when this page posts SKIP_WAITING because the user tapped Reload on the
// update banner. This is the ONLY intent a controller change carries: the
// controller that arrives afterwards replaces the bundle the page is running,
// so the `controllerchange` listener must reload for it. Every other controller
// change is something that happened *to* the page — a first install claiming
// it, or a worker replaced/evicted and reclaimed elsewhere — and must not throw
// the page away. See sw-controller-reload.js.
let acceptedUpdate = false;
// The worker the user's tap accepted, so we can tell "this activation is the
// one the tap caused" from "this worker had already activated". Cleared with
// `acceptedUpdate` the moment a reload consumes the intent.
let acceptedWorker = null;
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
  // The bundle this tap asked to replace is only protected while the worker is
  // still WAITING. `waitingWorker` is retained (some engines don't expose
  // `registration.waiting` immediately), so by the time the banner is tapped the
  // worker may already be active: its own activation finished, or another tab
  // accepted the same update first. Posting SKIP_WAITING to an active worker is
  // a no-op — nothing activates, no `controllerchange` arrives — so the tap
  // would appear to do nothing while leaving an armed intent behind to fire on
  // a later, unrelated claim. That stale intent was the random reload. The
  // banner is stale too: drop it, and apply it through the worker's activate
  // path like any other update instead of arming a reload that can never match.
  if (!isUpdateStillPending(worker.state)) {
    waitingWorker = null;
    updateAvailable.value = false;
    return;
  }
  applyingUpdate = true;
  // The user asked for this update. Record the intent BEFORE the worker can
  // activate: the `controllerchange` it produces has to reload even when this
  // page loaded uncontrolled (a first session claimed by the first install).
  // `acceptedWorker` is what later tells that activation apart from an
  // unrelated claim of a worker that had already activated.
  acceptedUpdate = true;
  acceptedWorker = worker;
  worker.postMessage({ type: 'SKIP_WAITING' });
}

// takeAcceptedUpdate() -> boolean
//
// The decision for one `controllerchange`, kept as a named unit so the intent
// can be consumed exactly once and the listener stays a thin adapter. Returns
// true when the page should reload (the caller performs it), and clears the
// one-shot intent so a single tap can never reload twice — or, worse, reload
// later against an activation it never asked for.
function takeAcceptedUpdate() {
  const accepted = shouldReloadOnControllerChange({
    hasController: !!navigator.serviceWorker.controller,
    acceptedUpdate,
    // `acceptedWorker` leaving the waiting slot is the proof that THIS
    // activation is the one the tap caused. A worker that activated before the
    // tap reports 'activated' (or is gone), so the intent is refused and
    // dropped instead of being spent on a claim the user never asked for.
    updateApplied: !!acceptedWorker && !isUpdateStillPending(acceptedWorker.state)
  });
  acceptedUpdate = false;
  acceptedWorker = null;
  return accepted;
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
    // A controller change on its own is never a reason to reload. The first
    // visit to an origin is one case: the worker's activate handler calls
    // clients.claim(), which controllerchanges the page that just painted, and
    // reloading there threw that page away — a white flash, a second document
    // load and a second chat fetch. The other case is a long-lived tab: any
    // worker that replaces the controller (a deploy another tab accepted, a
    // worker evicted and re-registered) also claims every open client, so this
    // listener used to reload tabs whose user had asked for nothing. The only
    // controller change worth acting on is the update the user accepted, which
    // `applyUpdate()` records in `acceptedUpdate` before posting SKIP_WAITING.
    // `takeAcceptedUpdate()` consumes that intent, so the reload can only ever
    // answer the activation the tap caused — never a later claim. The decision
    // itself lives in sw-controller-reload.js.
    if (refreshing) return;
    if (!takeAcceptedUpdate()) return;
    refreshing = true;
    window.location.reload();
  });
}
