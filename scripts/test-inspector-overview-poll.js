'use strict';

// Regression test for the Inspector Overview panel's metrics poll.
//
// OverviewPanel polls Performance.getMetrics on a 2.5 s cadence. Its effect
// depended on `props.metrics`, but the parent builds a fresh
// `() => handlers.fetchMetrics()` arrow on every render:
//
//   if (id === 'overview') return h(OverviewPanel, { metrics: () => handlers ? ... })
//
// so every parent render — including the one caused by each console/network
// row arriving — tore the loop down and started a new one, firing
// Performance.getMetrics once per render instead of every 2.5 s.
//
// The component is executed in a VM with a miniature Preact-hooks runtime
// (the same technique scripts/test-inspector-preview-zoom.js uses) so the
// assertion is about observable behaviour: how many times the loop starts,
// and which callback it calls.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../frontend/src/components/inspector/OverviewPanel.jsx'), 'utf8'
);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- Miniature hooks runtime -----------------------------------------
//
// Mimics Preact's contract for the part that matters: state and the effect
// teardown survive a re-render, and an effect re-runs when its dependency
// array changes by identity.
function createHarness() {
  const hooks = [];
  let index = 0;
  const instance = {
    effects: [],       // { deps, cleanup, run }
    effectRuns: 0,
    timers: [],
    cleared: 0,
    metrics: []
  };

  const useRef = (initial) => {
    if (!hooks[index]) hooks[index] = { current: initial };
    const ref = hooks[index];
    index++;
    return ref;
  };
  const useState = (initial) => {
    if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
    const slot = hooks[index];
    index++;
    return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
  };
  const useEffect = (fn, deps) => {
    const slot = instance.effects[index] || (instance.effects[index] = { deps: undefined, cleanup: null });
    const prev = slot.deps;
    const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, i) => d !== prev[i]);
    index++;
    if (!changed) return;
    if (slot.cleanup) slot.cleanup();
    slot.deps = deps;
    instance.effectRuns++;
    slot.cleanup = fn() || null;
  };

  const context = vm.createContext({
    console,
    setTimeout: (fn, ms) => { instance.timers.push({ fn, ms }); return instance.timers.length; },
    clearTimeout: () => { instance.cleared++; },
    Promise, Object, Array, String, Number, Error, JSON,
    h: (type, props, ...children) => ({ type, props, children }),
    fmtBytes: (n) => (n == null ? '' : String(n) + ' B'),
    useRef, useState, useEffect
  });
  const body = source.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  vm.runInContext(body + '; this.OverviewPanel = OverviewPanel;', context);

  return {
    instance,
    render(props) {
      index = 0;
      return context.OverviewPanel(props);
    },
    // Run the next scheduled tick, if any.
    async flushTimer() {
      const timer = instance.timers.shift();
      if (!timer) return false;
      await timer.fn();
      return true;
    }
  };
}

(async () => {
  const harness = createHarness();

  // First render: the panel starts its poll.
  const first = () => Promise.resolve({ documents: 1, frames: 1, nodes: 10, calls: harness.instance.metrics.length });
  harness.render({ metrics: first });
  check('the poll starts on mount', harness.instance.effectRuns === 1, 'runs=' + harness.instance.effectRuns);
  await Promise.resolve();

  // The parent re-renders 25 times with a fresh arrow each time (rows
  // arriving in the console/network panels cause exactly this).
  for (let i = 0; i < 25; i++) {
    harness.render({ metrics: () => Promise.resolve({ documents: 1, frames: 1, nodes: 10 + i }) });
    await Promise.resolve();
  }
  check('a fresh metrics arrow does not restart the poll',
    harness.instance.effectRuns === 1, 'runs=' + harness.instance.effectRuns);

  // The loop must still call the *latest* callback, not a stale closure.
  let latest = 0;
  harness.render({ metrics: () => { latest++; return Promise.resolve({ documents: 1, frames: 1, nodes: 42 }); } });
  await Promise.resolve();
  const ran = await harness.flushTimer();
  check('the loop kept its 2.5 s timer', ran === true);
  check('the timer calls the current metrics callback', latest === 1, 'called=' + latest);

  // One loop means one pending timer, not one per render.
  check('only one timer is pending', harness.instance.timers.length === 1,
    'timers=' + harness.instance.timers.length);

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
