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
// The three historic bugs this rule fixes:
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
//   3. Intent alone was not enough, because intent OUTLIVED the update it was
//      given for. `applyUpdate()` recorded the tap and then fell back to its
//      retained worker reference, so it could post SKIP_WAITING to a worker
//      that was ALREADY active — its activation finished before the tap, or
//      another tab applied the same update first. Nothing activates, no
//      `controllerchange` arrives, and the tap appears to do nothing — while
//      the one-shot intent stays latched. The NEXT unrelated activation then
//      claimed the page (`clients.claim()` runs on every activation), matched
//      the stale intent, and reloaded a tab whose user had asked for nothing at
//      a much later moment. That is the reported random reload:
//
//        a) deploy lands; the banner shows in two tabs
//        b) tab B taps Reload and the worker activates, claiming every client
//        c) tab A still shows its banner; its user taps Reload, which posts
//           SKIP_WAITING to the now-active worker — a no-op that leaves the
//           intent set and the banner up
//        d) a later deploy, accepted by B again, activates a worker that claims
//           A -> `controllerchange` + the stale intent -> A reloads by itself
//
//      So a controller change reloads only when it is the change the tap
//      EXPECTED: intent was recorded AND the accepted worker is no longer
//      waiting (it left the waiting slot, i.e. this activation is the one the
//      tap caused). A reload also *consumes* the intent, so a controller change
//      can never be replayed against it. See `shouldReloadOnControllerChange`'s
//      `updateApplied` input and scripts/test-sw-controller-reload.mjs.
//
// Why the controller's scriptURL is not part of the test: the app registers a
// single, constant `/sw.js`, so every version has the same script URL. A
// comparison would always say "same worker" — including for a real update —
// and would silently disable the accepted-update reload. The version that
// matters lives inside the script (CACHE_VERSION), not in its URL.

// isUpdateStillPending(state) -> boolean
//
// True while a `ServiceWorkerState` can still be the one the user's tap
// applies, i.e. the worker has NOT left the waiting slot yet.
//
// The web platform has no 'waiting' state, which is the trap here: a worker
// sitting in the waiting slot reports **'installed'** (verified against Chrome
// 140 — while a waiting update exists, `registration.waiting.state` is
// 'installed' and `registration.active.state` is 'activated'), an updating one
// reports 'installing', and 'parsed' is the state before either. Everything
// else — 'activating', 'activated', 'redundant' — means this worker has already
// left that slot, so no future `controllerchange` can be attributed to a tap
// that accepted it.
export function isUpdateStillPending(state) {
  return state === 'parsed' || state === 'installing' || state === 'installed';
}

// shouldReloadOnControllerChange(opts) -> boolean
//
//   opts.hasController     controller is non-null now
//   opts.acceptedUpdate    this page posted SKIP_WAITING after the user tapped
//                          Reload; false when omitted
//   opts.updateApplied     the worker the tap accepted has already left the
//                          waiting slot, so this activation is the one the tap
//                          caused. When false the intent is stale — the worker
//                          activated before the tap (another tab accepted it
//                          first) and a later claim must not be mistaken for
//                          the requested update.
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
  // The tap recorded intent, but the worker it asked for had ALREADY activated
  // (the waiting slot is empty for a reason other than this page's tap). The
  // banner is stale and there is no update this tap can still apply, so arming
  // a reload here is what turns a later, unrelated claim into a spontaneous
  // reload. Refuse it; the tap's own activation path is the only one that
  // reports `updateApplied`.
  if (!o.updateApplied) return false;
  // The user asked for this update and a controller now owns the page.
  return true;
}
