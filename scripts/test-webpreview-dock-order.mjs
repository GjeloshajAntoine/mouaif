// Regression test: the webpreview dock above the composer always shows the
// newest capture.
//
// Two paths used to let a stale capture take the dock over:
//   1. renderWebpreviewToolResult published on every lazy body build, so
//      opening an OLD webpreview card re-published that old screenshot;
//   2. the store only compared `capturedAt` when both captures had one, so
//      an untimed capture replaced a timed, newer one unconditionally.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const store = await import(path.join(here, '../frontend/src/components/chat/webpreviewState.js'));

let passed = 0;
function ok(name, fn) {
  store.clearActive();
  fn();
  passed++;
  console.log('  ok   - ' + name);
}

const shot = (capturedAt, id) => ({ thumbnail: 'data:image/png;base64,AA', capturedAt, id });

ok('the first capture is shown', () => {
  store.publish(shot('2026-09-25T10:00:00Z', 'a'));
  assert.equal(store.getActivePayload().id, 'a');
});

ok('a newer capture replaces an older one', () => {
  store.publish(shot('2026-09-25T10:00:00Z', 'a'));
  store.publish(shot('2026-09-25T10:05:00Z', 'b'));
  assert.equal(store.getActivePayload().id, 'b');
});

ok('an older capture does not replace a newer one', () => {
  store.publish(shot('2026-09-25T10:05:00Z', 'b'));
  store.publish(shot('2026-09-25T10:00:00Z', 'a'));
  assert.equal(store.getActivePayload().id, 'b');
});

ok('an untimed capture does not replace a timed one', () => {
  store.publish(shot('2026-09-25T10:05:00Z', 'b'));
  store.publish(shot(undefined, 'old'));
  assert.equal(store.getActivePayload().id, 'b');
});

ok('any capture replaces an untimed one', () => {
  store.publish(shot(undefined, 'old'));
  store.publish(shot(undefined, 'next'));
  assert.equal(store.getActivePayload().id, 'next');
  store.publish(shot('2026-09-25T10:05:00Z', 'b'));
  assert.equal(store.getActivePayload().id, 'b');
});

ok('a payload without a thumbnail is ignored', () => {
  store.publish(shot('2026-09-25T10:05:00Z', 'b'));
  store.publish({ capturedAt: '2026-09-25T11:00:00Z' });
  assert.equal(store.getActivePayload().id, 'b');
});

ok('expanding a webpreview card does not publish to the dock', () => {
  const src = fs.readFileSync(path.join(here, '../frontend/src/components/chat/toolRender.js'), 'utf8')
    .replace(/\/\/.*$/gm, '');
  const fn = /function renderWebpreviewToolResult[\s\S]*?\n}\n/.exec(src);
  assert.ok(fn, 'renderWebpreviewToolResult not found');
  assert.ok(!/publish/i.test(fn[0]), 'the lazy card body must not publish');
});

console.log('--- ' + passed + ' passed, 0 failed ---');
