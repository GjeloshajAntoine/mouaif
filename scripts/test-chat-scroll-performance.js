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
  let cleanup, mutation, resize, scans = 0, cancelled = false;
  const observed = new Set();
  const row = { nodeType: 1 };
  const transcriptEl = { get children() { scans++; return [row]; }, addEventListener() {}, removeEventListener() {} };
  row.parentNode = transcriptEl;
  const context = vm.createContext({
    useEffect: (fn) => { cleanup = fn(); }, transcript: { current: transcriptEl }, refs: {}, projectDir: '/test', chatId: 'test',
    ResizeObserver: class { constructor(fn) { resize = fn; } observe(node) { observed.add(node); } unobserve(node) { observed.delete(node); } disconnect() { observed.clear(); } },
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} disconnect() {} },
    pinTranscriptAfterSettle() {}, cancelTranscriptPin() { cancelled = true; }
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
  console.log('PASS nested text changes do not scan transcript rows; added/removed observers are cleaned up');
})().catch((error) => { console.error(error); process.exitCode = 1; });
