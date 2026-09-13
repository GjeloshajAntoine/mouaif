// Verifies the rule that decides when a service-worker controller change may
// reload the page.
//
// The bug this pins: on the FIRST visit to an origin the worker installs,
// activates, and calls clients.claim(), which takes control of the page that is
// already on screen and fires `controllerchange` on it. The old handler
// reloaded unconditionally, so a freshly painted chat was thrown away and
// reloaded once — a white flash and a second document load on a first open.
//
// Two layers are checked:
//   1. the pure predicate (frontend/src/sw-controller-reload.js), loaded
//      through a data: URL the same way scripts/test-git-count-format.mjs does;
//   2. the wiring in frontend/src/sw-registration.js, by scanning its source:
//      `controllerWasSet` must be sampled from `navigator.serviceWorker.controller`
//      and the reload must sit behind the predicate. A regression that drops the
//      guard (or re-samples the flag after the claim) fails here.
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

// First visit: the page loaded uncontrolled, clients.claim() adopted it.
// THIS is the reported flash/reload; it must not reload.
check('first install claimed the page', shouldReloadOnControllerChange({ controllerWasSet: false, hasController: true }), false);
// Nothing gained control (e.g. every install failed): nothing to adopt.
check('still uncontrolled', shouldReloadOnControllerChange({ controllerWasSet: false, hasController: false }), false);
// A page that was already controlled, and the worker accepted an update
// (SKIP_WAITING -> activate -> controllerchange): reload so the new bundle runs.
check('accepted update replaced the controller', shouldReloadOnControllerChange({ controllerWasSet: true, hasController: true }), true);
// The worker was unregistered/purged; a reload cannot bring it back.
check('controller removed', shouldReloadOnControllerChange({ controllerWasSet: true, hasController: false }), false);
// Defensive: no argument at all must not reload.
check('no options object', shouldReloadOnControllerChange(), false);
check('empty options object', shouldReloadOnControllerChange({}), false);

// ---- 1b. the update the user accepted ---------------------------------
//
// The case the load-time flag cannot see, and which shipped broken: on a FIRST
// session the page loaded uncontrolled, so `controllerWasSet` stays false for
// the document's whole life. A deploy then lands, the banner shows, and the user
// taps Reload -> SKIP_WAITING -> activate -> controllerchange. Refusing that
// reload dismissed the banner and left the old bundle running.
check('the update the user accepted reloads a first session',
  shouldReloadOnControllerChange({ controllerWasSet: false, hasController: true, acceptedUpdate: true }), true);
check('and it still reloads an already-controlled page',
  shouldReloadOnControllerChange({ controllerWasSet: true, hasController: true, acceptedUpdate: true }), true);
// No controller to run the new bundle: nothing a reload could pick up.
check('an accepted update with no controller does not reload',
  shouldReloadOnControllerChange({ controllerWasSet: false, hasController: false, acceptedUpdate: true }), false);
// Intent alone does not reload: the flag is the user's tap, not the install.
check('accepting without a controller change is not a reload',
  shouldReloadOnControllerChange({ controllerWasSet: true, hasController: true, acceptedUpdate: false }), true);
check('an omitted acceptedUpdate never reloads a first install',
  shouldReloadOnControllerChange({ controllerWasSet: false, hasController: true }), false);

// ---- 2. The wiring ----------------------------------------------------

const swReg = read('sw-registration.js');

// controllerWasSet is sampled from the live controller — not hard-coded, not
// read after the claim (the listener body must not re-sample it).
check('reads navigator.serviceWorker.controller at load time',
  /const controllerWasSet = [\s\S]{0,120}?navigator\.serviceWorker\.controller\b/.test(swReg), true);
check('imports the predicate',
  /import \{ shouldReloadOnControllerChange \} from '\.\/sw-controller-reload\.js';/.test(swReg), true);
check('controllerchange listener consults the predicate',
  /addEventListener\('controllerchange'[\s\S]*?shouldReloadOnControllerChange\(\{[\s\S]*?controllerWasSet,[\s\S]*?hasController:/.test(swReg), true);

// The accepted-update path: `applyUpdate()` records the intent, and the listener
// passes it to the predicate. `acceptedUpdate` must be set at/above the
// SKIP_WAITING post and read inside the listener — dropping either leaves the
// banner's Reload a silent no-op on a first session.
check('applyUpdate records the accepted update',
  /let acceptedUpdate = false[\s\S]*?function applyUpdate\(\)[\s\S]*?acceptedUpdate = true;[\s\S]*?postMessage\(\{ type: 'SKIP_WAITING' \}\)/.test(swReg), true);
check('the listener passes acceptedUpdate to the predicate',
  /shouldReloadOnControllerChange\(\{[\s\S]*?controllerWasSet,[\s\S]*?hasController:[\s\S]*?acceptedUpdate[\s\S]*?\}\)/.test(swReg), true);

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
check('the listener reloads for the update the user accepted in a first session',
  shouldReloadOnControllerChange({ controllerWasSet: false, hasController: true, acceptedUpdate: true }), true);

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nOK — controllerchange only reloads for an accepted update');
process.exit(failures ? 1 : 0);
