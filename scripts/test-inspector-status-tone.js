'use strict';
// Regression test for the Inspector status pill's tone.
//
// The pill has one animated tone (`busy`, an infinite 1.2 s opacity pulse on
// the leading dot — see `inspector__statuspill-pulse` in
// inspector-target-bar.css) and it must be reserved for work that is actually
// in flight. `classifyStatus` used to hand `busy` to "connected to …", the
// state the Inspector sits in for the whole session: the dot then pulsed
// forever directly above the Preview and Styles cards, and on a phone the
// moving dot plus the live preview read as the panel "blinking". This test
// locks in the split: in-flight wording pulses, settled wording does not, and
// failures stay red.
//
// `classifyStatus` is a pure function over the status text, but it lives in
// Inspector.jsx (a Preact component), so it is loaded the same way the other
// Inspector source tests do it: read the file, drop its imports and its other
// exports, and evaluate it in a VM context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../frontend/src/components/Inspector.jsx'), 'utf8');
// Keep only the classifyStatus function so the module's Preact references, its
// lazy CSS import and the rest of the component never have to resolve.
const match = src.match(/export function classifyStatus\([\s\S]*?\n\}\n/);
assert.ok(match, 'classifyStatus is exported from Inspector.jsx');
const context = vm.createContext({});
vm.runInContext(match[0].replace(/^export /m, ''), context);
const classifyStatus = context.classifyStatus;

// The steady states. None of these may pulse.
const steady = [
  'connected to Styles panel — element title by role',
  'now using http://127.0.0.1:9222',
  'saved.',
  'saved endpoint for http://127.0.0.1:9222',
  'reloaded',
  'closed',
  'opened http://example.com/',
  '3 targets',
  'applied',
  'copied selector div#app'
];
for (const text of steady) {
  assert.notEqual(classifyStatus(text), 'busy',
    'a settled state must not claim the animated tone: ' + text);
}
assert.equal(classifyStatus('connected to Styles panel'), 'ok', 'a connection reads as a settled success');
assert.equal(classifyStatus('3 targets'), 'ok', 'a target count reads as a settled success');

// The in-flight states — the only ones the pulse is for.
const inFlight = [
  'connecting…',
  'reloading…',
  'navigating to http://example.com/',
  'opening http://example.com/',
  'closing tab…',
  'fetching targets…',
  'saving…',
  'switching to profile 2',
  'going back…'
];
for (const text of inFlight) {
  assert.equal(classifyStatus(text), 'busy',
    'in-flight work keeps the pulse: ' + text);
}

// Failures and warnings outrank both, and the idle/info fallbacks survive.
assert.equal(classifyStatus('network error closing tab'), 'danger', 'a failure is red');
assert.equal(classifyStatus('disconnected (code 1006)'), 'danger', 'a disconnect is red');
assert.notEqual(classifyStatus('HTTP 502'), 'busy',
  'a transport status line never claims the pulse (it is neutral unless the body carried an error)');
assert.equal(classifyStatus(''), 'idle', 'no status is idle');
assert.equal(classifyStatus(null), 'idle', 'a missing status is idle');
assert.equal(classifyStatus('something else'), 'info', 'unclassified text is neutral');
assert.equal(classifyStatus('careful, warn'), 'warn', 'a warning is its own tone');

// The pulse itself must stay declared on the busy tone alone: if a future edit
// moves the animation onto a class the steady states also carry, the rule above
// stops being enough.
const css = fs.readFileSync(path.join(__dirname, '../frontend/src/inspector-target-bar.css'), 'utf8');
const pulsing = [...css.matchAll(/([^{}]*)\{[^{}]*animation:\s*inspector__statuspill-pulse/g)]
  .map((m) => m[1].trim().replace(/\s+/g, ' '));
assert.deepStrictEqual(pulsing, ['.inspector__statuspill--busy .inspector__statuspill-dot'],
  'only the busy tone animates the status dot');

console.log('PASS inspector status tone (pulse reserved for in-flight status, steady states settle)');
