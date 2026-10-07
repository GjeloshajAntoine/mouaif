'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

(async () => {
  const { afterTranscriptAppend, pinTranscriptAfterSettle, cancelTranscriptPin, scrollTranscriptToBottom, isTranscriptPinScroll } = await import('../frontend/src/components/chat/scroll.js');
  const queue = new Map();
  let nextId = 0;
  global.requestAnimationFrame = (fn) => { queue.set(++nextId, fn); return nextId; };
  global.cancelAnimationFrame = (id) => queue.delete(id);
  const frame = () => { const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach((fn) => fn()); };
  let reads = 0, writes = 0, height = 1000, top = 400;
  const el = {
    get scrollHeight() { reads++; return height; },
    get scrollTop() { return top; },
    set scrollTop(value) { writes++; top = value; },
    clientHeight: 500
  };
  const refs = { transcript: { current: el }, pinnedToBottom: { current: true }, pendingCount: { current: 0 }, jumpBtn: { current: null } };
  for (let i = 0; i < 100; i++) afterTranscriptAppend(refs, false);
  // Resize and mutation notifications must reuse the same callback.
  pinTranscriptAfterSettle(refs);
  assert.equal(queue.size, 1);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  frame();
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.equal(top, 500);
  assert.equal(isTranscriptPinScroll(refs, top), true);
  height = 1300; // late image/tool expansion
  pinTranscriptAfterSettle(refs);
  frame();
  assert.equal(top, 800);
  assert.equal(isTranscriptPinScroll(refs, 650), false); // user moved before event
  frame(); frame();
  assert.equal(queue.size, 0);
  console.log('PASS 100 deltas share one frame, one height read and one write; late growth follows');

  height = 1500;
  pinTranscriptAfterSettle(refs);
  refs.pinnedToBottom.current = false;
  const before = writes;
  frame();
  assert.equal(writes, before);
  for (let i = 0; i < 100; i++) afterTranscriptAppend(refs, false);
  assert.equal(queue.size, 0);
  afterTranscriptAppend(refs, true);
  assert.equal(refs.pendingCount.current, 1);
  scrollTranscriptToBottom(refs);
  assert.equal(refs.pendingCount.current, 0);
  frame();
  assert.equal(top, 1000);
  refs._insertAnchor = {};
  frame();
  assert.equal(queue.size, 0);
  refs._insertAnchor = null;
  pinTranscriptAfterSettle(refs);
  cancelTranscriptPin(refs);
  assert.equal(queue.size, 0);
  pinTranscriptAfterSettle(refs);
  refs.transcript.current = null;
  frame();
  assert.equal(queue.size, 0);
  console.log('PASS unpin, jump, pagination suspension, cancellation and detached views');

  // Execute the production observer effect and check row tracking without
  // a browser dependency. Nested mutations must never enumerate all rows.
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/useChatState.js'), 'utf8');
  const start = source.indexOf('  useEffect(() => {\n    const el = transcript.current;');
  const end = source.indexOf('  }, [projectDir, chatId]);', start) + '  }, [projectDir, chatId]);'.length;
  let cleanup, mutation, resize, scans = 0, cancelled = false, intentDisposed = false;
  const observed = new Set();
  const row = { nodeType: 1 };
  const transcriptEl = { get children() { scans++; return [row]; }, addEventListener() {}, removeEventListener() {} };
  row.parentNode = transcriptEl;
  const context = vm.createContext({
    useEffect: (fn) => { cleanup = fn(); }, transcript: { current: transcriptEl }, refs: {}, projectDir: '/test', chatId: 'test',
    ResizeObserver: class { constructor(fn) { resize = fn; } observe(node) { observed.add(node); } unobserve(node) { observed.delete(node); } disconnect() { observed.clear(); } },
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} disconnect() {} },
    pinTranscriptAfterSettle() {}, cancelTranscriptPin() { cancelled = true; },
    syncNavScrollbarLane() {},
    trackUserScrollIntent() { return { isUserScroll: () => false, dispose() { intentDisposed = true; } }; }
  });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(scans, 1);
  for (let i = 0; i < 100; i++) mutation([{ type: 'characterData', target: row }, { type: 'childList', target: row }]);
  assert.equal(scans, 1);
  const added = { nodeType: 1, parentNode: transcriptEl };
  mutation([{ type: 'childList', target: transcriptEl, addedNodes: [added], removedNodes: [] }]);
  assert.equal(observed.has(added), true);
  row.parentNode = null;
  mutation([{ type: 'childList', target: transcriptEl, addedNodes: [], removedNodes: [row] }]);
  assert.equal(observed.has(row), false);
  resize();
  cleanup();
  assert.equal(observed.size, 0);
  assert.equal(cancelled, true);
  assert.equal(intentDisposed, true);
  console.log('PASS nested text changes do not scan transcript rows; added/removed observers are cleaned up');

  // Only user input may unpin. A browser-caused scroll (content-visibility
  // clamp, scroll anchoring, streaming growth) must keep following.
  const { trackUserScrollIntent } = await import('../frontend/src/components/chat/scroll.js');
  const listeners = {};
  const target = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || new Set()).add(fn); },
    removeEventListener(type, fn) { if (listeners[type]) listeners[type].delete(fn); }
  };
  const fire = (type, ev = {}) => { for (const fn of listeners[type] || []) fn(ev); };
  let clock = 1000;
  const intent = trackUserScrollIntent(target, () => clock);
  assert.equal(intent.isUserScroll(), false, 'no input -> not a user scroll');
  fire('wheel', { deltaY: 120 });
  assert.equal(intent.isUserScroll(), false, 'a downward wheel cannot leave the bottom');
  fire('wheel', { deltaY: -120 });
  assert.equal(intent.isUserScroll(), true, 'an upward wheel counts');
  clock += 1000;
  assert.equal(intent.isUserScroll(), false, 'intent window expires');
  fire('touchstart');
  clock += 5000;
  assert.equal(intent.isUserScroll(), true, 'a held touch counts however long');
  fire('touchend');
  clock += 200;
  assert.equal(intent.isUserScroll(), true, 'momentum right after touchend counts');
  clock += 200;
  assert.equal(intent.isUserScroll(), true, 'each momentum scroll extends the window');
  clock += 1000;
  assert.equal(intent.isUserScroll(), false, 'momentum over');
  fire('keydown', { key: 'a' });
  assert.equal(intent.isUserScroll(), false, 'typing is not scrolling');
  fire('keydown', { key: 'Home', target: { tagName: 'TEXTAREA' } });
  assert.equal(intent.isUserScroll(), false, 'caret keys in the composer do not count');
  fire('keydown', { key: 'End', target: { tagName: 'BODY' } });
  assert.equal(intent.isUserScroll(), false, 'downward keys do not count');
  fire('keydown', { key: 'PageUp', target: { tagName: 'BODY' } });
  assert.equal(intent.isUserScroll(), true, 'scroll keys count');
  intent.dispose();
  const remaining = Object.values(listeners).reduce((n, set) => n + set.size, 0);
  assert.equal(remaining, 0, 'dispose removes every listener');
  console.log('PASS only wheel/touch/key/pointer input unpins; momentum is attributed; listeners disposed');

  // The rail's offset is driven by the lane the transcript's scrollbar
  // actually takes. Measure it, never assume the breakpoint's 10px: an
  // overlay scrollbar (every phone) reserves nothing, and a classic one is
  // as wide as the platform makes it.
  const { syncNavScrollbarLane } = await import('../frontend/src/components/chat/scroll.js');
  function laneHarness(metrics) {
    const style = new Map();
    const box = {
      style: {
        getPropertyValue: (name) => (style.has(name) ? style.get(name) : ''),
        setProperty(name, value) { style.set(name, value); }
      }
    };
    const el = Object.assign({ parentElement: box }, metrics);
    return { refs: { transcript: { current: el } }, style, box };
  }
  {
    // A classic bar with the reserved gutter: 10px on the right only.
    const h = laneHarness({ offsetWidth: 768, clientWidth: 748, clientLeft: 10 });
    syncNavScrollbarLane(h.refs);
    assert.equal(h.style.get('--nav-scrollbar'), '10px', 'the reserved right lane is published');
  }
  {
    // Overlay scrollbar: no lane at all, so the rail keeps the frame edge.
    const h = laneHarness({ offsetWidth: 390, clientWidth: 390, clientLeft: 0 });
    syncNavScrollbarLane(h.refs);
    assert.equal(h.style.get('--nav-scrollbar'), '0px', 'an overlay scrollbar reserves nothing');
  }
  {
    // No gutter reserved, but a classic bar still takes its own slice.
    const h = laneHarness({ offsetWidth: 768, clientWidth: 758, clientLeft: 0 });
    syncNavScrollbarLane(h.refs);
    assert.equal(h.style.get('--nav-scrollbar'), '10px', 'a bar without a gutter still counts');
  }
  {
    // A left border must not be mistaken for the scrollbar's lane.
    const h = laneHarness({ offsetWidth: 768, clientWidth: 758, clientLeft: 1 });
    syncNavScrollbarLane(h.refs);
    assert.equal(h.style.get('--nav-scrollbar'), '9px', 'the left inset is not counted as the lane');
  }
  {
    // Detached view: no transcript, no write, and no throw.
    const write = () => { throw new Error('must not write'); };
    syncNavScrollbarLane({ transcript: { current: null } });
    syncNavScrollbarLane({ transcript: { current: { parentElement: null, style: { setProperty: write } } } });
  }
  console.log('PASS the scrollbar lane is measured from the live scroller, not assumed from a breakpoint');
})().catch((error) => { console.error(error); process.exitCode = 1; });
