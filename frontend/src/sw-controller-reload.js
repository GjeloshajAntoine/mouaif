// mouaif web — when a service-worker controller change may reload the page.
//
// Kept separate from sw-registration.js (which does the browser wiring) so the
// decision is testable without a DOM: see scripts/test-sw-controller-reload.mjs.
//
// Why this exists
// ---------------
// A controller change is NEVER a reason to reload on its own. The page is only
// allowed to throw itself away when the user asked for the update this session
// offered. Every other controller change is something that happened *to* the
// page, and reloading it there is a bug the user sees as a random reload:
//
//   | accepted update | controller now | reload | why                                  |
//   | --------------- | -------------- | ------ | ------------------------------------ |
//   | yes             | yes            | yes    | the user tapped Reload on the banner  |
//   | no              | yes            | no     | first install claimed us (clients.claim) |
//   | no              | yes            | no     | the worker was replaced/evicted and reclaimed |
//   | no              | no             | no     | controller gone; a reload cannot restore it |
//
// The two historic bugs this rule fixes:
//
//   1. The handler used to reload on EVERY controllerchange. The first visit to
//      an origin installs the worker, and the worker's activate handler calls
//      `clients.claim()`, which takes control of the page already on screen and
//      fires `controllerchange` — for a page that was NOT controlled when it
//      loaded. Reloading there threw away a page that had just painted: a full
//      white flash and a second document load, reported as "the chat view seems
//      to flash and reload" on an origin being opened for the first time (or on
//      a fresh profile / private window).
//
//   2. The first fix refused the first-install reload by keying on "was this
//      page controlled when it loaded?". But `clients.claim()` on a later
//      activation claims EVERY open client, so any worker that replaced the
//      controller — a deploy another tab accepted, a worker evicted and then
//      re-registered — fired `controllerchange` on already-controlled, open
//      chat tabs, and the load-time flag answered "yes, controlled" for a
//      change those tabs never asked for. They reloaded anyway, at a moment
//      tied to deploys and worker churn rather than to the user: the same
//      random-reload symptom, now on long-lived tabs.
//
// `acceptedUpdate` is the only signal that carries intent. The caller sets it
// in sw-registration.js `applyUpdate()` when it posts SKIP_WAITING, so the tap
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
//   opts.hasController     controller is non-null now
//   opts.acceptedUpdate    this page posted SKIP_WAITING after the user tapped
//                          Reload; false when omitted
export function shouldReloadOnControllerChange(opts) {
  const o = opts || {};
  // Nothing controls the page: a reload would not bring a worker back, so
  // there is nothing to pick up.
  if (!o.hasController) return false;
  // The controller change was not this page's request. It may be a first
  // install claiming a page that loaded uncontrolled, or a worker that was
  // replaced or evicted and reclaimed by someone else. This page is running a
  // bundle the server still serves, and the next natural navigation picks up
  // the new one, so there is nothing to force here.
  if (!o.acceptedUpdate) return false;
  // The user asked for this update and a controller now owns the page.
  return true;
}
