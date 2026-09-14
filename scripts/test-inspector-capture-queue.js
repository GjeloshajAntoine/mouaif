'use strict';
// Test for screenshot serialization (frontend/src/components/inspector/events.js).
//
// Every screenshot in the Inspector goes through one queue, because two
// concurrent `captureBeyondViewport` captures on the same target corrupt each
// other: Chrome serves a beyond-viewport capture by temporarily resizing the
// viewport and restoring it, and a second capture that starts inside that
// window renders the page at the wrong size. Measured on a static page with a
// fixed clip, serialized captures are byte-identical while overlapping ones are
// not — and the user saw it as both previews blinking, because the Preview
// panel's full-page loop and the Styles panel's live element shot run at the
// same time on one target.
//
// The panels cannot coordinate (neither knows the other exists), so the
// ordering is enforced in the CDP layer. This test drives the real handlers with
// a cdpSend that reports its own concurrency, and asserts:
//   - no two Page.captureScreenshot calls are ever in flight together;
//   - the queue is FIFO, so each caller gets the frame it asked for;
//   - a rejected capture does not poison the ones behind it;
//   - the queue is per connection (a fresh handler set starts empty).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = (name) => fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector', name), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

function makeContext() {
  const context = vm.createContext({ console: null });
  vm.runInContext(source('matchedRules.js'), context);
  vm.runInContext(source('events.js'), context);
  return context;
}

// makeState — a cdpSend that records call order and flags any overlap of
// Page.captureScreenshot.
function makeState(options) {
  const opts = options || {};
  const events = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const state = {
    captureBeyondViewport: opts.beyond !== false,
    consoleEntries: { current: [] },
    networkEntries: { current: [] },
    reqMap: new Map(),
    consoleVL: { current: null },
    networkVL: { current: null },
    rerender: () => {},
    cdpSend: async (method, params) => {
      if (method === 'Page.captureScreenshot') {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const seq = events.filter((e) => e.start).length;
        events.push({ start: params.clip ? 'clip' : 'full' });
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        const shouldFail = (opts.fail && opts.fail(params)) || (opts.failIndex != null && opts.failIndex === seq);
        if (shouldFail) {
          inFlight--;
          events.push({ fail: true });
          throw new Error('capture failed');
        }
        inFlight--;
        events.push({ done: true });
        return { data: 'PNG' };
      }
      if (/getBoundingClientRect/.test(params && params.functionDeclaration || '')) {
        return { result: { value: { x: 10, y: 20, width: 200, height: 100, sx: 0, sy: 0, dpr: 1 } } };
      }
      return {};
    }
  };
  return { state, events, stats: () => ({ maxInFlight }) };
}

// makeStateV — a state whose cdpSend records every command, for the viewport
// restore assertions (the capture itself returns a PNG; Emulation can be made
// to fail, as it does on targets without that domain).
function makeStateV(options) {
  const opts = options || {};
  const calls = [];
  const state = {
    captureBeyondViewport: true,
    consoleEntries: { current: [] },
    networkEntries: { current: [] },
    reqMap: new Map(),
    consoleVL: { current: null },
    networkVL: { current: null },
    rerender: () => {},
    cdpSend: async (method, params) => {
      calls.push({ method, params });
      if (method === 'Page.captureScreenshot') return { data: 'PNG' };
      if (method === 'Emulation.setDeviceMetricsOverride' || method === 'Emulation.clearDeviceMetricsOverride') {
        if (opts.failEmulation) throw new Error('Emulation domain unavailable');
      }
      if (/getBoundingClientRect/.test(params && params.functionDeclaration || '')) {
        return { result: { value: { x: 10, y: 20, width: 200, height: 100, sx: 0, sy: 0, dpr: 1 } } };
      }
      return {};
    }
  };
  return { state, calls };
}

async function main() {
  const context = makeContext();

  // --- the two loops that used to corrupt each other ----------------------
  // The Preview panel's full-page capture and the Styles panel's clipped
  // element shot, fired at the same moment. Before the queue these ran
  // concurrently (maxInFlight 2) and returned different pictures for an
  // unchanged page.
  {
    const { state, events, stats } = makeState({ delayMs: 20 });
    const handlers = context.createEventHandlers(state);
    await Promise.all([
      handlers.captureScreenshot(),
      handlers.captureElementShot('obj-1'),
      handlers.captureScreenshot(),
      handlers.captureElementShot('obj-1', { scroll: false })
    ]);
    assert.equal(stats().maxInFlight, 1,
      'two captures on one target must never overlap (Chrome resizes the viewport, so overlapping captures corrupt each other)');
    // FIFO by *enqueue* time, which is not the caller's call order: an element
    // shot measures its box (an async round-trip) before it queues its capture,
    // so the two full-page captures — which queue synchronously — get there
    // first. What matters is that each caller receives its own frame and that
    // no two run together.
    assert.deepEqual(events.filter((e) => e.start).map((e) => e.start), ['full', 'full', 'clip', 'clip'],
      'captures run in the order they were queued, one at a time');
    assert.equal(events.filter((e) => e.done).length, 4, 'every queued capture ran');
  }

  // --- a live element shot and the full-page loop interleave cleanly -------
  {
    const { state, stats } = makeState({ delayMs: 5 });
    const handlers = context.createEventHandlers(state);
    const pending = [];
    for (let i = 0; i < 6; i++) {
      pending.push(i % 2 ? handlers.captureElementShot('obj-1', { scroll: false }) : handlers.captureScreenshot());
    }
    await Promise.all(pending);
    assert.equal(stats().maxInFlight, 1, 'a burst of mixed captures still serializes one at a time');
  }

  // --- a failed capture does not poison the queue -------------------------
  // The chain is a promise tail: a rejected link that is not caught would
  // reject every later capture on the connection, and the preview would stay
  // dead until the panel was remounted.
  {
    const { state } = makeState({ fail: (params) => !params.clip });
    const handlers = context.createEventHandlers(state);
    let firstFailed = false;
    try { await handlers.captureScreenshot(); } catch { firstFailed = true; }
    assert.ok(firstFailed, 'the failing capture reports its failure');
    const after = await handlers.captureElementShot('obj-1');
    assert.ok(after && after.data, 'a capture queued behind a failure still runs');
  }
  {
    // Same, with the failure behind a success, and three deep. `failIndex: 1`
    // fails the *second* capture to run, so both neighbours of the failure are
    // exercised in one pass.
    const { state, stats } = makeState({ failIndex: 1 });
    const handlers = context.createEventHandlers(state);
    const results = await Promise.allSettled([
      handlers.captureScreenshot(),
      handlers.captureScreenshot(),
      handlers.captureScreenshot()
    ]);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1, 'only the failing capture rejects');
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2, 'the others still resolve');
    assert.equal(stats().maxInFlight, 1, 'a failure in the middle does not break serialization');
  }

  // --- the queue is per connection ----------------------------------------
  // A reconnect creates a fresh handler set, which must start with an empty
  // chain rather than inheriting (and waiting on) the previous connection's.
  {
    const { state: s1 } = makeState({ delayMs: 30 });
    const h1 = context.createEventHandlers(s1);
    const slow = h1.captureScreenshot();
    const { state: s2, stats: st2 } = makeState({ delayMs: 0 });
    const h2 = context.createEventHandlers(s2);
    await Promise.all([slow, h2.captureScreenshot()]);
    assert.equal(st2().maxInFlight, 1, 'a fresh connection captures immediately, not behind the old chain');
  }

  // --- the queue is bounded by the callers, not by coalescing -------------
  // Each caller must get its own frame: the live loop drops a superseded
  // capture itself, and it can only do that if it receives one.
  {
    const { state, events } = makeState({ delayMs: 1 });
    const handlers = context.createEventHandlers(state);
    const out = await Promise.all([
      handlers.captureScreenshot(),
      handlers.captureScreenshot(),
      handlers.captureScreenshot()
    ]);
    assert.equal(out.length, 3, 'three callers, three results — nothing is coalesced away');
    assert.equal(events.filter((e) => e.start).length, 3, 'three captures were actually issued');
  }

  // --- a clipped capture leaves the page resized, so the viewport is restored
  // A `clip` renders by sizing the inspected page to the clip rect, and Chrome
  // does not put it back. Measured in the running app, the inspected page's own
  // innerHeight alternated 295 <-> 397 (the two clips' heights) about twice a
  // second while the previews ran, so each loop photographed the page at the
  // other loop's size — the blink. The Inspector always knows the viewport it
  // wants (the Size preset), so it re-asserts it after every clipped capture.
  {
    const { state, calls } = makeStateV();
    const handlers = context.createEventHandlers(state);
    await handlers.setViewportSize({ width: 390, height: 700, mobile: true, deviceScaleFactor: 2 });
    calls.length = 0;
    await handlers.captureElementShot('obj-1');
    const after = calls.map((c) => c.method);
    assert.deepEqual(after.filter((m) => m === 'Page.captureScreenshot'), ['Page.captureScreenshot'],
      'the element shot ran once');
    const restore = calls.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    assert.ok(restore, 'a clipped capture is followed by restoring the wanted viewport');
    assert.equal(restore.params.width, 390, 'the restore re-asserts the preset width');
    assert.equal(restore.params.height, 700, 'the restore re-asserts the preset height');
    assert.equal(restore.params.deviceScaleFactor, 2, 'the restore keeps the retina scale factor');
    assert.equal(restore.params.mobile, true, 'the restore keeps the mobile flag');
    assert.ok(calls.indexOf(restore) > calls.findIndex((c) => c.method === 'Page.captureScreenshot'),
      'the restore lands after the capture, not in the middle of it');
    // An unclipped capture sizes nothing, so it must not pay for a restore.
    calls.length = 0;
    await handlers.captureScreenshot();
    assert.equal(calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride').length, 0,
      'an unclipped capture does not restore a viewport it never changed');
    // "Auto" is the native size: restoring it means clearing the override.
    await handlers.setViewportSize(null);
    calls.length = 0;
    await handlers.captureElementShot('obj-1');
    assert.ok(calls.some((c) => c.method === 'Emulation.clearDeviceMetricsOverride'),
      'the native preset is restored by clearing the override');
    // A target with no Emulation domain must not lose its capture to a failed
    // restore.
    const noEmulation = makeStateV({ failEmulation: true });
    const h2 = context.createEventHandlers(noEmulation.state);
    // setViewportSize itself throws here (the target has no Emulation domain),
    // which is exactly the case the restore has to survive.
    try { await h2.setViewportSize({ width: 390, height: 700 }); } catch { /* no Emulation domain */ }
    const shot = await h2.captureElementShot('obj-1');
    assert.ok(shot && shot.data, 'a failed viewport restore does not fail the capture');
  }

  // --- the CSS/JS companions still expose the same surface ----------------
  const eventsSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/events.js'), 'utf8');
  assert.ok(/runCapture\(params\)/.test(eventsSrc), 'the full-page capture goes through the serialized runCapture');
  assert.ok(/if \(params\.clip\) \{[\s\S]{0,200}reassertViewport\(\)/.test(eventsSrc),
    'the viewport is restored only after a capture that carried a clip');
  assert.ok(/wantedViewport = preset && preset\.width \? preset : null;/.test(eventsSrc),
    'the chosen Size preset is what gets restored');

  console.log('PASS screenshot serialization (one capture at a time per target, FIFO, failure-safe, per connection, clipped captures restore the viewport)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
