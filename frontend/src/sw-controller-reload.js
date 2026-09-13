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
// So the decision keys on control state sampled at LOAD time, plus one piece of
// explicit intent:
//
//   | controlled when loaded | controlled now | accepted | reload | why            |
//   | ---------------------- | -------------- | -------- | ------ | -------------- |
//   | no                     | yes            | no       | no     | first install claimed us |
//   | no                     | yes            | yes      | yes    | the user accepted the update offered this session |
//   | no                     | no             | —        | no     | nothing to adopt |
//   | yes                    | yes            | —        | yes    | an accepted update took over |
//   | yes                    | no             | —        | no     | worker unregistered; a reload cannot restore it |
//
// `controllerWasSet` must be sampled ONCE, at module/registration time, from
// `navigator.serviceWorker.controller`. Sampling it when the event fires reads
// the value clients.claim() has already flipped, which is the bug this module
// documents.
//
// Why the load-time flag alone is not enough, and `acceptedUpdate` exists
// ----------------------------------------------------------------------
// The load-time flag answers "did a controller already own this document?",
// which is the right question for a controllerchange nobody asked for. It is
// the WRONG question for one the user just asked for. On a first visit the page
// is uncontrolled at load, the worker claims it, and the banner's Reload button
// is still live: a deploy that lands while that first session is open shows "A
// new version is ready.", the user taps Reload, the worker posts SKIP_WAITING
// and activate fires `controllerchange` — on a page whose `controllerWasSet` is
// false for the rest of its life. The load-time flag alone therefore refused the
// reload the banner had just promised: tapping Reload dismissed the banner and
// left the session running the old bundle, with no way to pick up the new one
// short of a manual page reload. The caller sets `acceptedUpdate` (in
// sw-registration.js, `applyUpdate()`) when it posts SKIP_WAITING, so the tap
// that asked for the update is part of the decision instead of something
// inferred from control state.
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
//   opts.acceptedUpdate    this page posted SKIP_WAITING after the user tapped
//                          Reload; false when omitted
export function shouldReloadOnControllerChange(opts) {
  const o = opts || {};
  // The case the load-time flag cannot see: the user accepted the update this
  // very session offered. The tap is the intent, the new worker already owns
  // the page (hasController), and reloading is the whole point of it.
  if (o.acceptedUpdate && o.hasController) return true;
  if (!o.controllerWasSet) return false; // a first install claimed this fresh page
  if (!o.hasController) return false; // controller removed; a reload would not bring it back
  return true;
}
