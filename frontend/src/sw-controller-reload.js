// mouaif web — when a service-worker controller change may reload the page.
//
// Kept separate from sw-registration.js (which does the browser wiring) so the
// decision is testable without a DOM: see scripts/test-sw-controller-reload.mjs.
//
// Why this exists
// ---------------
// The first visit to a mouaif origin installs the service worker, and the
// worker's activate handler calls `clients.claim()`. That takes control of the
// page that is already on screen, which fires `controllerchange` on the
// window — for a page that was NOT controlled when it loaded. Reloading on
// that event threw away a page that had just painted and loaded its chat for
// no reason: a full white flash and a second document load, reported as "the
// chat view seems to flash and reload" on an origin being opened for the first
// time (or on a fresh profile / private window).
//
// The predicate is therefore the page's control state at LOAD time:
//
//   | controlled when loaded | controlled now | reload | why                       |
//   | ---------------------- | -------------- | ------ | ------------------------- |
//   | no                     | yes            | no     | first install claimed us  |
//   | no                     | no             | no     | nothing to adopt          |
//   | yes                    | yes            | yes    | an accepted update took over |
//   | yes                    | no             | no     | worker unregistered; a reload cannot restore it |
//
// `controllerWasSet` must be sampled ONCE, at module/registration time, from
// `navigator.serviceWorker.controller`. Sampling it when the event fires reads
// the value clients.claim() has already flipped, which is the bug this module
// documents.
//
// Why the controller's scriptURL is not part of the test: the app registers a
// single, constant `/sw.js`, so every version has the same script URL. A
// comparison would always say "same worker" — including for a real update —
// and would silently disable the accepted-update reload. The version that
// matters lives inside the script (CACHE_VERSION), not in its URL.

// shouldReloadOnControllerChange(opts) -> boolean
//
//   opts.controllerWasSet  controller was non-null when the page loaded
//   opts.hasController     controller is non-null now
export function shouldReloadOnControllerChange(opts) {
  const o = opts || {};
  if (!o.controllerWasSet) return false; // a first install claimed this fresh page
  if (!o.hasController) return false; // controller removed; a reload would not bring it back
  return true;
}
