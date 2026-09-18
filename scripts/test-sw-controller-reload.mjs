// Verifies the rule that decides when a service-worker controller change may
// reload the page.
//
// The bug this pins: on the FIRST visit to an origin the worker installs,
// activates, and calls clients.claim(), which takes control of the page that is
// already on screen and fires `controllerchange` on it. The old handler
// reloaded unconditionally, so a freshly painted chat was thrown away and
// reloaded once — a white flash and a second document load on a first open.
//
// The second bug it pins: `clients.claim()` on ANY later activation claims every
// open client, so a worker that replaced the controller — a deploy another tab
// accepted, a worker evicted and re-registered — fired `controllerchange` on
// already-controlled chat tabs. Keying on a load-time "was this page controlled?"
// flag therefore reloaded long-lived tabs at a moment tied to deploys and worker
// churn, not to the user. The only intent a controller change can carry is an
// update the user accepted; everything else must leave the page alone.
//
// The third bug it pins — the reported "random reload" — is intent that outlived
// the update it was given for. `applyUpdate()` fell back to a RETAINED worker
// reference, so it could post SKIP_WAITING to a worker that was already active
// (another tab accepted the same update first). Nothing activated, no
// `controllerchange` arrived, and the one-shot intent stayed latched; the next
// unrelated activation claimed the page, matched the stale intent, and reloaded
// a tab whose user had asked for nothing — minutes or hours later. The predicate
// now also requires `updateApplied` (the accepted worker has left the waiting
// slot, i.e. this activation is the one the tap caused), and the caller consumes
// the intent, so a controller change can never be replayed against it.
//
// Two layers are checked:
//   1. the pure predicate (frontend/src/sw-controller-reload.js), loaded
//      through a data: URL the same way scripts/test-git-count-format.mjs does;
//   2. the wiring in frontend/src/sw-registration.js, by scanning its source:
//      the listener must consume the intent through the predicate, the
//      predicate call must pass `acceptedUpdate` AND `updateApplied`, the
//      retired load-time flag must stay gone, and `applyUpdate()` must refuse
//      to arm an intent against a worker that is no longer waiting. A
//      regression that drops any of those fails here.
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL('../frontend/src/' + file, import.meta.url), 'utf8');

const { shouldReloadOnControllerChange, isUpdateStillPending } = await import(
  'data:text/javascript;base64,'
  + Buffer.from(read('sw-controller-reload.js')).toString('base64')
);

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log((ok ? '  ok  - ' : '  FAIL- ') + name
    + (ok ? '' : ' :: got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)));
}

// ---- 1. The predicate -------------------------------------------------

// First visit: the page loaded uncontrolled, clients.claim() adopted it with no
// user intent. THIS is the reported flash/reload; it must not reload.
check('first install claimed the page', shouldReloadOnControllerChange({ hasController: true }), false);
// Nothing gained control (e.g. every install failed): nothing to adopt.
check('still uncontrolled', shouldReloadOnControllerChange({ hasController: false }), false);
// The regression this rule also fixes: an ALREADY-CONTROLLED, long-lived tab.
// A worker that replaces the controller claims every open client, which is a
// controller change that page never asked for. It must not reload, whether the
// caller still passes the retired load-time flag or not.
check('an unrequested controller change does not reload a controlled page',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: false }), false);
check('a stale load-time flag cannot force a reload',
  shouldReloadOnControllerChange({ controllerWasSet: true, hasController: true, acceptedUpdate: false }), false);
// A page that was already controlled, and the user accepted the update
// (SKIP_WAITING -> activate -> controllerchange): reload so the new bundle runs.
check('accepted update replaced the controller',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: true, updateApplied: true }), true);
// The worker was unregistered/purged; a reload cannot bring it back.
check('controller removed', shouldReloadOnControllerChange({ hasController: false, acceptedUpdate: true, updateApplied: true }), false);
// Defensive: no argument at all must not reload.
check('no options object', shouldReloadOnControllerChange(), false);
check('empty options object', shouldReloadOnControllerChange({}), false);

// ---- 1b. the update the user accepted ---------------------------------
//
// On a FIRST session the page loaded uncontrolled. A deploy then lands, the
// banner shows, and the user taps Reload -> SKIP_WAITING -> activate ->
// controllerchange. Refusing that reload dismissed the banner and left the old
// bundle running.
check('the update the user accepted reloads a first session',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: true, updateApplied: true }), true);
check('and it still reloads an already-controlled page',
  shouldReloadOnControllerChange({ controllerWasSet: true, hasController: true, acceptedUpdate: true, updateApplied: true }), true);
// No controller to run the new bundle: nothing a reload could pick up.
check('an accepted update with no controller does not reload',
  shouldReloadOnControllerChange({ hasController: false, acceptedUpdate: true, updateApplied: true }), false);
// Intent is required: a controller present but no tap is not a reload.
check('a controller change with no tap is not a reload',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: false, updateApplied: true }), false);

// ---- 1c. the stale intent (the reported random reload) -----------------
//
// THE most recently reported symptom. `applyUpdate()` posted SKIP_WAITING to a
// worker that had already activated — another tab accepted the same update
// first — so no `controllerchange` followed the tap and the intent stayed
// armed. A later, unrelated activation (a different deploy, applied by another
// tab) claimed this page and matched that stale intent, reloading it with no
// user action. `updateApplied` is the input that separates the two: a tap whose
// worker is still waiting has NOT produced an activation, so a controller
// change now cannot be attributed to it.
check('a tap whose worker had already activated does not reload',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: true, updateApplied: false }), false);
// The reused-intent shape, spelled out: the same stale intent plus a claim.
check('a later claim cannot consume a stale intent',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: true, updateApplied: false }), false);
// An absent `updateApplied` is treated as "not applied" — the conservative
// reading, so a caller that forgets it fails closed (no spontaneous reload)
// rather than open.
check('an omitted updateApplied fails closed',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: true }), false);
// The tap that IS followed by its own activation still reloads.
check('the tap whose worker left the waiting slot reloads',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: true, updateApplied: true }), true);

// ---- 1d. the waiting-slot vocabulary (the trap that broke the first fix) ---
//
// The web platform has NO 'waiting' state. A worker sitting in the waiting slot
// reports **'installed'** — verified against Chrome 140: while a waiting update
// exists, `registration.waiting.state === 'installed'` and
// `registration.active.state === 'activated'`. A guard written against a
// 'waiting' string therefore refuses EVERY genuine update, so no accepted tap
// ever reloads. These pin the real vocabulary.
check('a worker in the waiting slot is still pending (state "installed")',
  isUpdateStillPending('installed'), true);
check('a freshly parsed worker is still pending', isUpdateStillPending('parsed'), true);
check('an installing worker is still pending', isUpdateStillPending('installing'), true);
check('an activating worker has left the waiting slot', isUpdateStillPending('activating'), false);
check('an activated worker has left the waiting slot', isUpdateStillPending('activated'), false);
check('a redundant worker has left the waiting slot', isUpdateStillPending('redundant'), false);
check('an unknown state is not treated as pending', isUpdateStillPending(undefined), false);
// The exact pair Chrome 140 reports while an update is waiting. The waiting
// worker must read as pending; the active one must not.
check('Chrome 140: waiting="installed" is pending', isUpdateStillPending('installed'), true);
check('Chrome 140: active="activated" is not pending', isUpdateStillPending('activated'), false);

// ---- 2. The wiring ----------------------------------------------------

const swReg = read('sw-registration.js');

// The listener must consult the predicate, and must NOT sample a load-time
// control flag any more: a controller change is reloaded only for an update the
// user accepted. `controllerWasSet` was the flag that let an unrequested claim
// reload every already-controlled tab.
check('imports the predicate',
  /import \{ shouldReloadOnControllerChange, isUpdateStillPending \} from '\.\/sw-controller-reload\.js';/.test(swReg), true);
check('the listener routes the decision through the consuming helper',
  /addEventListener\('controllerchange'[\s\S]*?takeAcceptedUpdate\(\)/.test(swReg), true);
check('the retired load-time control flag is gone',
  /controllerWasSet/.test(swReg), false);

// The accepted-update path: `applyUpdate()` records the intent, and the
// listener passes it to the predicate. `acceptedUpdate` must be set at/above
// the SKIP_WAITING post and read inside the listener — dropping either leaves
// the banner's Reload a silent no-op.
check('applyUpdate records the accepted update',
  /function applyUpdate\(\)[\s\S]*?acceptedUpdate = true;[\s\S]*?acceptedWorker = worker;[\s\S]*?postMessage\(\{ type: 'SKIP_WAITING' \}\)/.test(swReg), true);

// THE fix for the stale intent: an intent is only armed against a worker that
// has not left the waiting slot. Posting SKIP_WAITING to an already-active
// worker is a no-op that used to leave the one-shot intent latched for a later,
// unrelated claim. The predicate is `isUpdateStillPending`, NOT a comparison
// against the nonexistent 'waiting' state.
check('applyUpdate refuses a worker that already activated',
  /if \(!isUpdateStillPending\(worker\.state\)\) \{[\s\S]*?updateAvailable\.value = false;[\s\S]*?return;/.test(swReg), true);
check('the stale-worker branch runs BEFORE the intent is armed',
  swReg.indexOf('!isUpdateStillPending(worker.state)') < swReg.indexOf('acceptedUpdate = true;')
  && swReg.indexOf('!isUpdateStillPending(worker.state)') > 0, true);
check('the banner is dismissed for a stale worker',
  /!isUpdateStillPending\(worker\.state\)[\s\S]{0,220}updateAvailable\.value = false;/.test(swReg), true);
check('and it is NOT compared against a "waiting" string',
  /worker\.state !== 'waiting'/.test(swReg), false);

// The intent must be CONSUMED, not merely read: a single tap can only ever
// reload once, and a controller change that the tap did not cause must clear
// the intent instead of leaving it armed.
check('the intent is consumed exactly once',
  /function takeAcceptedUpdate\(\)[\s\S]*?shouldReloadOnControllerChange\(\{[\s\S]*?\}\);[\s\S]*?acceptedUpdate = false;[\s\S]*?acceptedWorker = null;/.test(swReg), true);
check('the predicate call passes acceptedUpdate',
  /shouldReloadOnControllerChange\(\{[\s\S]*?acceptedUpdate,[\s\S]*?\}\)/.test(swReg), true);
check('the predicate call passes updateApplied',
  /shouldReloadOnControllerChange\(\{[\s\S]*?updateApplied:[\s\S]*?\}\)/.test(swReg), true);
// `updateApplied` must be derived from the accepted worker's own state, not
// from a second, independent notion of "an update finished".
check('updateApplied reads the accepted worker state',
  /updateApplied: !!acceptedWorker && !isUpdateStillPending\(acceptedWorker\.state\)/.test(swReg), true);
check('the registration imports the state predicate too',
  /import \{ shouldReloadOnControllerChange, isUpdateStillPending \} from '\.\/sw-controller-reload\.js';/.test(swReg), true);

// A bare first install with no user intent activates a worker without posting
// SKIP_WAITING, so `acceptedUpdate` is false when its claim lands.
check('a first install activates without recording intent',
  /else worker\.postMessage\(\{ type: 'SKIP_WAITING' \}\); \/\/ first install has no old bundle to protect/.test(swReg), true);
check('and that claim does not reload', shouldReloadOnControllerChange({
  hasController: true, acceptedUpdate: false
}), false);

// The reload must be behind the guard: find the listener body and assert the
// guard test precedes `location.reload()`.
const listenerAt = swReg.indexOf("addEventListener('controllerchange'");
const guardAt = swReg.indexOf('takeAcceptedUpdate()', listenerAt);
const reloadAt = swReg.indexOf('window.location.reload()', listenerAt);
check('listener found', listenerAt >= 0, true);
check('guard precedes the reload', guardAt >= 0 && reloadAt > guardAt, true);

// The retired bug shape: a listener that reloads with no predicate between the
// event registration and the reload.
check('no unguarded reload in the listener', /addEventListener\('controllerchange', \(\) => \{\s*if \(refreshing\) return;\s*refreshing = true;\s*window\.location\.reload\(\);/.test(swReg), false);

// The accepted-update case as it actually reaches the listener through the
// predicate the file loads, so the source-scan above cannot pass while the
// runtime behaviour is wrong.
check('the listener reloads for the update the user accepted',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: true, updateApplied: true }), true);
// And the reported symptom does not come back through the predicate the file
// loads: a claim nobody asked for leaves an open chat tab alone.
check('an unrequested claim leaves an open chat tab alone',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: false }), false);
check('and a claim against a stale intent leaves it alone too',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: true, updateApplied: false }), false);

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nOK — controllerchange only reloads for the update the user accepted');
process.exit(failures ? 1 : 0);
