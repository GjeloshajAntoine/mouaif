'use strict';

// Regression test for the virtual list driver's programmatic scroll.
//
// A browser clamps `scrollTop` against the element's *current* content
// height. setData() only schedules a render (the spacer is resized in the
// next animation frame), so setData() followed by scrollToIndex() in the
// same tick used to write scrollTop while the spacer still described the
// previous list:
//
//   list.setData(rows);      // schedules a frame
//   list.scrollToIndex(90);  // spacer still short → browser clamps to the
//                            // old end, or to 0 on a first render
//
// The fix renders the pending frame before writing scrollTop. The test
// stubs a minimal DOM whose scroller clamps scrollTop the way a browser
// does, so the assertion is about behaviour rather than source shape.

const assert = require('node:assert/strict');

// ---- Minimal DOM ------------------------------------------------------

function makeNode() {
  const node = {
    nodeType: 1,
    children: [],
    parentNode: null,
    style: {},
    _listeners: {},
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = node.children.indexOf(child);
      if (i >= 0) node.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, cb) { (node._listeners[type] = node._listeners[type] || []).push(cb); },
    removeEventListener(type, cb) {
      const list = node._listeners[type] || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type) { for (const cb of (node._listeners[type] || []).slice()) cb({ type }); }
  };
  return node;
}

// The scroller knows its content height from its (single) spacer child and
// clamps scrollTop to `content - clientHeight`, like a real element.
function makeScroller(clientHeight) {
  const scroller = makeNode();
  const raw = { top: 0 };
  Object.defineProperty(scroller, 'clientHeight', { value: clientHeight });
  scroller.contentHeight = function () {
    let height = 0;
    for (const child of scroller.children) {
      const px = parseFloat(String(child.style.height || '0').replace('px', ''));
      if (Number.isFinite(px)) height = Math.max(height, px);
    }
    return height;
  };
  Object.defineProperty(scroller, 'scrollTop', {
    get() { return raw.top; },
    set(value) {
      const max = Math.max(0, scroller.contentHeight() - clientHeight);
      raw.top = Math.max(0, Math.min(value, max));
      scroller.clampedTo = max;
      scroller.dispatch('scroll');
    }
  });
  return scroller;
}

function installDom(scroller) {
  global.window = {
    _frames: new Map(),
    _next: 0,
    requestAnimationFrame(fn) { window._frames.set(++window._next, fn); return window._next; },
    cancelAnimationFrame(id) { window._frames.delete(id); },
    addEventListener() {},
    removeEventListener() {}
  };
  global.document = { createElement: () => makeNode() };
  return function flush() {
    const pending = [...window._frames.values()];
    window._frames.clear();
    for (const fn of pending) fn();
  };
}

// ---- Checks -----------------------------------------------------------

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

(async () => {
  const { createVirtualList } = await import('../frontend/src/virtual-list.js');

  const ITEM = 44;

  // A real scroller cannot go past `content - viewportHeight`, so the
  // expected value is the clamped one, not index * itemHeight.
  const expectedScroll = (index, count, clientHeight) =>
    Math.min(index * ITEM, Math.max(0, count * ITEM - clientHeight));

  // 1. A long list scrolled near its end in the same tick as setData().
  //    Before the fix the spacer was still empty, so the browser clamped
  //    this to 0 and the programmatic scroll did nothing.
  {
    const scroller = makeScroller(200);
    const flush = installDom(scroller);
    const list = createVirtualList({ scroller, itemHeight: ITEM, data: [] });
    flush();
    list.setData(Array.from({ length: 100 }, (_, i) => i));
    list.scrollToIndex(90);
    check('scrollToIndex lands on the requested row after setData',
      scroller.scrollTop === expectedScroll(90, 100, 200),
      'scrollTop=' + scroller.scrollTop + ' expected=' + expectedScroll(90, 100, 200));
    check('the spacer grew to the new list height',
      scroller.contentHeight() === 100 * ITEM, 'height=' + scroller.contentHeight());
    list.destroy();
  }

  // 2. The same call on a shrinking list must land inside the new bounds
  //    instead of being clamped to the old content height.
  {
    const scroller = makeScroller(200);
    const flush = installDom(scroller);
    const list = createVirtualList({ scroller, itemHeight: ITEM, data: [] });
    flush();
    list.setData(Array.from({ length: 100 }, (_, i) => i));
    flush();
    list.scrollToIndex(99);
    check('setup: the long list scrolled to its end',
      scroller.scrollTop === expectedScroll(99, 100, 200), 'scrollTop=' + scroller.scrollTop);

    // The new content is 440 px tall in a 200 px viewport, so the deepest
    // legal offset is 240 px. Before the fix the spacer still described the
    // 100-row list, so scrollTop was accepted as 396 — a position the
    // browser then corrected on the next layout, jumping the view.
    list.setData(Array.from({ length: 10 }, (_, i) => i));
    list.scrollToIndex(9);
    check('a shrinking list scrolls inside the new content',
      scroller.scrollTop === expectedScroll(9, 10, 200),
      'scrollTop=' + scroller.scrollTop + ' expected=' + expectedScroll(9, 10, 200));
    check('the spacer shrank to the new list height',
      scroller.contentHeight() === 10 * ITEM, 'height=' + scroller.contentHeight());
    check('the rendered range stays valid',
      list._range().start <= list._range().end && list._range().end <= 10,
      JSON.stringify(list._range()));
    list.destroy();
  }

  // 3. An empty list after a long one must not throw or produce a negative
  //    pool (the computeRange contract, exercised through the driver).
  {
    const scroller = makeScroller(800);
    const flush = installDom(scroller);
    const list = createVirtualList({ scroller, itemHeight: ITEM, data: Array.from({ length: 100 }, (_, i) => i) });
    flush();
    list.scrollToIndex(99);
    let threw = null;
    try {
      list.setData([]);
      list.scrollToIndex(5);
      flush();
    } catch (e) { threw = e; }
    check('emptying the list renders without throwing', threw === null, threw && threw.message);
    check('the empty list reports a zero range',
      list._range() && list._range().start === 0 && list._range().end === 0,
      JSON.stringify(list._range()));
    list.destroy();
  }

  // 4. Out-of-range indices clamp to the list instead of escaping it.
  {
    const scroller = makeScroller(100);
    const flush = installDom(scroller);
    const list = createVirtualList({ scroller, itemHeight: ITEM, data: Array.from({ length: 5 }, (_, i) => i) });
    flush();
    list.scrollToIndex(-3);
    check('a negative index scrolls to the top', scroller.scrollTop === 0, 'scrollTop=' + scroller.scrollTop);
    list.scrollToIndex(999);
    check('an index past the end scrolls to the last row',
    scroller.scrollTop === expectedScroll(4, 5, 100),
    'scrollTop=' + scroller.scrollTop + ' expected=' + expectedScroll(4, 5, 100));
    list.destroy();
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
