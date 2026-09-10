'use strict';

// Regression test for the virtual list's range math.
//
// computeRange() is pure, so the whole contract can be brute-forced. The
// caller (createVirtualList) uses it as:
//
//   spacer height = padTop + (end - start) * itemHeight + padBottom
//   pool size     = end - start
//
// `start > end` therefore produced a negative pool size, which popped
// `undefined` out of an empty pool and then threw inside a
// requestAnimationFrame callback. It happened whenever the scroll offset
// sat past the last item — the list shrinking under an offset that was
// valid for the previous, longer list (setData() after a filter or a
// rescan, e.g. the file-tagging view).

const assert = require('node:assert/strict');

(async () => {
  const { computeRange } = await import('../frontend/src/virtual-list.js');

  const ITEM = 44;
  const OVERSCAN = 4;
  const VIEWPORT = 800;
  const MAX_COUNT = 60;

  let checked = 0;
  let failures = 0;
  const bad = [];

  for (let count = 1; count <= MAX_COUNT; count++) {
    for (let scrollTop = 0; scrollTop <= count * ITEM + 5 * ITEM; scrollTop += ITEM / 2) {
      for (const viewportHeight of [0, 1, 200, VIEWPORT, 5000]) {
        const range = computeRange({ itemHeight: ITEM, overscan: OVERSCAN, scrollTop, viewportHeight, count });
        checked++;
        const rows = range.end - range.start;
        const total = range.padTop + rows * ITEM + range.padBottom;
        const where = `count=${count} scrollTop=${scrollTop} viewport=${viewportHeight}`;
        const problems = [];
        if (!(range.start >= 0)) problems.push('start < 0');
        if (!(range.end >= range.start)) problems.push('end < start (pool size ' + rows + ')');
        if (!(range.end <= count)) problems.push('end > count');
        if (!(range.start <= count)) problems.push('start > count');
        if (!(range.padTop >= 0)) problems.push('padTop < 0');
        if (!(range.padBottom >= 0)) problems.push('padBottom < 0');
        // The spacer must always describe the full list, whatever the
        // scroll position: the native scrollbar depends on it.
        if (total !== count * ITEM) problems.push(`height ${total} !== ${count * ITEM}`);
        // Every item at or below the viewport start must still be covered
        // when the scroll offset is inside the list.
        if (scrollTop <= (count - 1) * ITEM) {
          if (!(range.end > Math.floor(scrollTop / ITEM))) problems.push('renders nothing at the offset');
        }
        if (problems.length) {
          failures++;
          if (bad.length < 5) bad.push(`${where}: ${problems.join(', ')} → ${JSON.stringify(range)}`);
        }
      }
    }
  }

  console.log(`  ok   - ${checked} range computations checked`);
  for (const line of bad) console.log('  FAIL - ' + line);
  assert.equal(failures, 0, `${failures} of ${checked} ranges violated the contract`);

  // The exact reported shape: a long list, then a short one, without the
  // browser having clamped scrollTop yet.
  const shrunk = computeRange({ itemHeight: ITEM, overscan: OVERSCAN, scrollTop: 1500 * ITEM, viewportHeight: VIEWPORT, count: 10 });
  assert.deepEqual(shrunk, { start: 10, end: 10, padTop: 440, padBottom: 0 });
  assert.equal(shrunk.end - shrunk.start, 0, 'no rows, so the pool shrinks to zero instead of going negative');
  assert.equal(shrunk.padTop + (shrunk.end - shrunk.start) * ITEM + shrunk.padBottom, 10 * ITEM);

  // An empty list stays the documented zero-range.
  assert.deepEqual(
    computeRange({ itemHeight: ITEM, overscan: OVERSCAN, scrollTop: 500, viewportHeight: VIEWPORT, count: 0 }),
    { start: 0, end: 0, padTop: 0, padBottom: 0 }
  );

  // A bad item height is still a hard error.
  assert.throws(() => computeRange({ itemHeight: 0, overscan: 0, scrollTop: 0, viewportHeight: 100, count: 5 }),
    /itemHeight must be > 0/);

  console.log('PASS range contract holds for every scroll position, list length, and viewport');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
