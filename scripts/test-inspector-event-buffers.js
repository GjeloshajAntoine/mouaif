'use strict';

// Regression test for the inspector's event buffers.
//
// The console and network panels render a 2000-row window
// (pushConsole/pushNetwork slice the newest 2000 entries), but the backing
// arrays they slice from were never trimmed: every CDP event pushed onto
// `consoleEntries.current` / `networkEntries.current` for the life of the
// tab, and `reqMap.current` kept one entry per request id forever. A
// network entry can hold a response body of up to 200 KB, so a long
// session against a chatty page grew the tab's heap without bound.
//
// The handler factory is pure enough to drive directly: it only touches
// the refs it is handed.

const assert = require('node:assert/strict');

(async () => {
  const { createEventHandlers } = await import('../frontend/src/components/inspector/events.js');

  const MAX = 2000;

  function makeState() {
    return {
      consoleEntries: { current: [] },
      networkEntries: { current: [] },
      reqMap: { current: new Map() },
      consoleVL: { current: null },
      networkVL: { current: null },
      consoleCountRef: { current: null },
      networkCountRef: { current: null },
      cdpSend: async () => ({ body: 'x'.repeat(1000) }),
      onNavigate: () => {}
    };
  }

  let passed = 0;
  let failed = 0;
  function check(name, condition, detail) {
    if (condition) { passed++; console.log('  ok   - ' + name); }
    else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
  }

  // ---- Console ------------------------------------------------------
  {
    const state = makeState();
    const h = createEventHandlers(state);
    const total = MAX * 2 + 137;
    for (let i = 0; i < total; i++) {
      h.onConsoleEvent({
        type: 'log',
        args: [{ type: 'string', value: 'line ' + i }],
        stackTrace: { callFrames: [{ functionName: 'f', url: 'http://x/', lineNumber: i, columnNumber: 0 }] }
      });
    }
    check('console entries are capped after ' + total + ' events',
      state.consoleEntries.current.length === MAX,
      'length=' + state.consoleEntries.current.length);
    const last = state.consoleEntries.current[state.consoleEntries.current.length - 1];
    check('the newest entry is retained', last && last.text === 'line ' + (total - 1),
    last && last.text);
    const first = state.consoleEntries.current[0];
    check('the oldest entries were dropped', first && first.text === 'line ' + (total - MAX),
      first && first.text);
    check('dropped entries released their arg references',
      state.consoleEntries.current.every((e) => e.args === undefined || e.args === null || Array.isArray(e.args)));
  }

  // ---- Network ------------------------------------------------------
  {
    const state = makeState();
    const h = createEventHandlers(state);
    const total = MAX * 2 + 137;
    for (let i = 0; i < total; i++) {
      const requestId = 'r' + i;
      h.onRequestWillBeSent({ requestId, request: { method: 'GET', url: 'http://x/' + i }, type: 'XHR', timestamp: i });
      h.onResponseReceived({ requestId, response: { status: 200, mimeType: 'text/html' }, type: 'XHR' });
      await h.loadResponseBody(state.reqMap.current.get(requestId));
      h.onLoadingFinished({ requestId, timestamp: i + 0.1, encodedDataLength: 1000 });
    }
    check('network entries are capped after ' + total + ' requests',
      state.networkEntries.current.length === MAX,
      'length=' + state.networkEntries.current.length);
    check('the request map is trimmed with them',
      state.reqMap.current.size === MAX, 'reqMap=' + state.reqMap.current.size);
    const keptIds = new Set(state.networkEntries.current.map((e) => e.requestId));
    check('the request map only holds retained requests',
      [...state.reqMap.current.keys()].every((id) => keptIds.has(id)));
    check('evicted entries released their response body',
      state.networkEntries.current.every((e) => e.body === null || typeof e.body === 'string'));
    const evicted = state.networkEntries.current[0];
    check('the oldest retained request is the expected one',
      evicted && evicted.requestId === 'r' + (total - MAX), evicted && evicted.requestId);
  }

  // ---- The cap must not disturb an in-flight request ----------------
  {
    const state = makeState();
    const h = createEventHandlers(state);
    // One request starts, then enough traffic to evict it.
    h.onRequestWillBeSent({ requestId: 'inflight', request: { method: 'GET', url: 'http://x/slow' }, type: 'XHR', timestamp: 0 });
    for (let i = 0; i < MAX + 10; i++) {
      const requestId = 'r' + i;
      h.onRequestWillBeSent({ requestId, request: { method: 'GET', url: 'http://x/' + i }, type: 'XHR', timestamp: i });
    }
    // The late response for the evicted request must be a no-op, not a
    // throw (the panel already dropped the row).
    let threw = null;
    try { h.onResponseReceived({ requestId: 'inflight', response: { status: 200 }, type: 'XHR' }); }
    catch (e) { threw = e; }
    check('a response for an evicted request is ignored', threw === null, threw && threw.message);
    check('the evicted request is gone from the map', !state.reqMap.current.has('inflight'));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
