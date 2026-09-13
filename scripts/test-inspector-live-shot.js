'use strict';
// Test for the Styles panel's live element preview pacing (liveShot.js).
//
// The pinned element preview has to keep up with the inspected page on its own,
// and the way it does that — one capture per interval, none while the app is in
// the background, none while the user's own capture is running, and no timer
// left behind when the panel goes away — is the whole point of the module. None
// of it can be observed in a unit test of the panel, so the policy is exercised
// here with fake timers: no DOM, no CDP, no Chrome.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/liveShot.js'), 'utf8')
  .replace(/^export /gm, '');

// makeClock — a setTimeout the test drives by hand. `fire()` runs the timer the
// loop armed, so the test controls time instead of waiting for it. It never
// awaits the capture: the loop's own promise handling is what the test observes
// through `flush()`.
function makeClock() {
  const armed = [];
  const cleared = [];
  let next = 0;
  return {
    armed,
    cleared,
    setTimer(fn, ms) { const id = ++next; armed.push({ id, fn, ms }); return id; },
    clearTimer(id) { cleared.push(id); const i = armed.findIndex((t) => t.id === id); if (i >= 0) armed.splice(i, 1); },
    fire() {
      const timer = armed.shift();
      if (!timer) return null;
      timer.fn();
      return timer.ms;
    }
  };
}

// flush — let the loop's awaited capture settle (and any continuation run).
async function flush() {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}

async function main() {
  const context = vm.createContext({ console: null });
  vm.runInContext(source, context);
  // `const`/`export const` land in the context's global lexical scope, which is
  // only reachable from another script in the same context.
  const { createLiveShot, LIVE_SHOT_MS } = vm.runInContext('({ createLiveShot, LIVE_SHOT_MS })', context);

  assert.equal(LIVE_SHOT_MS, 800, 'the interval is under a second so the preview reads as live');

  // --- one capture per interval, armed after the previous one finished -----
  {
    const clock = makeClock();
    const shots = [];
    let resolveCapture = null;
    const loop = createLiveShot({
      capture: () => new Promise((res) => { shots.push('start'); resolveCapture = res; }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    loop.start();
    assert.equal(clock.armed.length, 1, 'start() arms exactly one timer');
    assert.equal(clock.armed[0].ms, LIVE_SHOT_MS, 'the first tick waits one interval');
    clock.fire();
    assert.deepEqual(shots, ['start'], 'a tick captures once');
    // The capture is still in flight: nothing may be armed yet, and a second
    // tick (a slow page) must not start a capture of its own.
    assert.equal(clock.armed.length, 0, 'the next tick is armed only after the capture finishes');
    resolveCapture();
    await flush();
    assert.equal(clock.armed.length, 1, 'the loop re-arms once the capture resolved');
    assert.equal(shots.length, 1, 'no overlapping capture was started');
    loop.stop();
    assert.equal(clock.armed.length, 0, 'stop() clears the pending timer');
  }

  // --- skipped in the background, and while a manual capture runs ----------
  {
    const clock = makeClock();
    let hidden = true;
    let busy = true;
    let captures = 0;
    const loop = createLiveShot({
      capture: async () => { captures++; },
      isHidden: () => hidden,
      busy: () => busy,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    loop.start();
    clock.fire();
    await flush();
    assert.equal(captures, 0, 'a hidden app captures nothing');
    assert.equal(clock.armed.length, 1, 'a skipped tick still keeps the schedule');
    hidden = false;
    clock.fire();
    await flush();
    assert.equal(captures, 0, 'a capture the user asked for is not duplicated');
    busy = false;
    clock.fire();
    await flush();
    assert.equal(captures, 1, 'the loop picks the page back up once it is free');
    loop.stop();
  }

  // --- a failing capture is a no-op, not the end of the loop --------------
  {
    const clock = makeClock();
    let attempts = 0;
    const loop = createLiveShot({
      capture: async () => { attempts++; if (attempts === 1) throw new Error('cdp closed'); },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    loop.start();
    clock.fire();
    await flush();
    assert.equal(attempts, 1, 'the first capture was attempted');
    assert.equal(clock.armed.length, 1, 'a failed capture keeps the loop scheduled');
    clock.fire();
    await flush();
    assert.equal(attempts, 2, 'the loop retries on the next tick');
    loop.stop();
  }

  // --- stop() during a capture does not re-arm ----------------------------
  // Otherwise a panel that unmounted (or a selection that was cleared) would
  // keep a hidden preview capturing for the life of the page.
  {
    const clock = makeClock();
    let resolveCapture = null;
    let captures = 0;
    const loop = createLiveShot({
      capture: () => { captures++; return new Promise((res) => { resolveCapture = res; }); },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    loop.start();
    clock.fire();
    loop.stop();
    resolveCapture();
    await flush();
    assert.equal(captures, 1, 'the in-flight capture is left to finish');
    assert.equal(clock.armed.length, 0, 'a stopped loop never arms another tick');
    clock.fire();
    await flush();
    assert.equal(captures, 1, 'firing a cleared timer captures nothing');
  }

  // --- a pathological interval is clamped ---------------------------------
  {
    const clock = makeClock();
    const loop = createLiveShot({ capture: async () => {}, intervalMs: 5, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    loop.start();
    assert.equal(clock.armed[0].ms, 200, 'a too-tight interval is clamped rather than hammering the page');
    loop.stop();
    const sameLoopTwice = createLiveShot({ capture: async () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    sameLoopTwice.start();
    sameLoopTwice.start();
    assert.equal(clock.armed.length, 1, 'start() twice does not run two loops');
    sameLoopTwice.stop();
  }

  // --- the panel wires it up ---------------------------------------------
  // The pacing is only worth testing if the panel actually runs it: the effect
  // keys on the selected element, and the live capture is the non-centring one.
  const panelSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/StylesPanel.jsx'), 'utf8');
  assert.ok(/^import \{ createLiveShot \} from '\.\/liveShot\.js';$/m.test(panelSrc),
    'the Styles panel imports the live loop');
  assert.ok(/useEffect\(\(\) => \{[\s\S]{0,400}createLiveShot\(\{[\s\S]{0,200}capture: captureShotLive/.test(panelSrc),
    'the loop is created in an effect with the panel\'s live capture');
  assert.ok(/\[model && model\.objectId, props\.captureElementShot\]/.test(panelSrc),
    'the loop is keyed on the selected element and the capture handler');
  assert.ok(/loop\.start\(\);\s*return \(\) => loop\.stop\(\);/.test(panelSrc),
    'the loop runs for the life of the selection only');

  console.log('PASS inspector live element preview pacing (one capture per interval, paused when hidden or busy, stopped on unmount)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
