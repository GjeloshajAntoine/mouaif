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
// Two layers are checked:
//   1. the pure predicate (frontend/src/sw-controller-reload.js), loaded
//      through a data: URL the same way scripts/test-git-count-format.mjs does;
//   2. the wiring in frontend/src/sw-registration.js, by scanning its source:
//      the listener must consult the predicate, must pass `acceptedUpdate`, and
//      must not fall back to a load-time control flag. A regression that drops
//      the guard (or re-introduces the flag) fails here.
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL('../frontend/src/' + file, import.meta.url), 'utf8');

const { shouldReloadOnControllerChange } = await import(
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
check('accepted update replaced the controller', shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: true }), true);
// The worker was unregistered/purged; a reload cannot bring it back.
check('controller removed', shouldReloadOnControllerChange({ hasController: false, acceptedUpdate: true }), false);
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
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: true }), true);
check('and it still reloads an already-controlled page',
  shouldReloadOnControllerChange({ controllerWasSet: true, hasController: true, acceptedUpdate: true }), true);
// No controller to run the new bundle: nothing a reload could pick up.
check('an accepted update with no controller does not reload',
  shouldReloadOnControllerChange({ hasController: false, acceptedUpdate: true }), false);
// Intent is required: a controller present but no tap is not a reload.
check('a controller change with no tap is not a reload',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: false }), false);

// ---- 2. The wiring ----------------------------------------------------

const swReg = read('sw-registration.js');

// The listener must consult the predicate, and must NOT sample a load-time
// control flag any more: a controller change is reloaded only for an update the
// user accepted. `controllerWasSet` was the flag that let an unrequested claim
// reload every already-controlled tab.
check('imports the predicate',
  /import \{ shouldReloadOnControllerChange \} from '\.\/sw-controller-reload\.js';/.test(swReg), true);
check('controllerchange listener consults the predicate',
  /addEventListener\('controllerchange'[\s\S]*?shouldReloadOnControllerChange\(\{[\s\S]*?acceptedUpdate/.test(swReg), true);
check('the retired load-time control flag is gone',
  /controllerWasSet/.test(swReg), false);
check('the listener does not sample navigator.serviceWorker.controller to decide',
  /hasController: !!navigator\.serviceWorker\.controller/.test(swReg), true);

// The accepted-update path: `applyUpdate()` records the intent, and the listener
// passes it to the predicate. `acceptedUpdate` must be set at/above the
// SKIP_WAITING post and read inside the listener — dropping either leaves the
// banner's Reload a silent no-op.
check('applyUpdate records the accepted update',
  /let acceptedUpdate = false[\s\S]*?function applyUpdate\(\)[\s\S]*?acceptedUpdate = true;[\s\S]*?postMessage\(\{ type: 'SKIP_WAITING' \}\)/.test(swReg), true);
check('the listener passes acceptedUpdate to the predicate',
  /shouldReloadOnControllerChange\(\{[\s\S]*?hasController:[\s\S]*?acceptedUpdate[\s\S]*?\}\)/.test(swReg), true);

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
const guardAt = swReg.indexOf('shouldReloadOnControllerChange(', listenerAt);
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
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: true }), true);
// And the reported symptom does not come back through the predicate the file
// loads: a claim nobody asked for leaves an open chat tab alone.
check('an unrequested claim leaves an open chat tab alone',
  shouldReloadOnControllerChange({ hasController: true, acceptedUpdate: false }), false);

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nOK — controllerchange only reloads for an accepted update');
process.exit(failures ? 1 : 0);
