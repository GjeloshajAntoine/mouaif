// Virtual list primitive — windowed rendering with recycled nodes.
//
// Design goals (from .github/copilot-instructions.md):
//   - Low memory: only `overscan + visible` DOM nodes exist, regardless of list length.
//   - Low CPU: no forced reflow on scroll; reads are batched, writes are coalesced.
//   - Mobile-first: fixed item height (this commit) keeps the renderer simple
//     and fast; a variable-height pass is shaped to be additive later.
//
// Usage (browser, ES modules):
//   import { createVirtualList } from '/web/virtual-list.js';
//   const list = createVirtualList({ scroller, itemHeight: 44, overscan: 4, render, data });
//
// Usage (Node, CJS):
//   const { createVirtualList, computeRange } = require('mouaif/src/virtual-list.js');
//
// Public surface:
//   createVirtualList(options) -> { setData, getData, refresh, scrollToIndex, destroy, _range }
//   computeRange({ itemHeight, overscan, scrollTop, viewportHeight, count })
//                                -> { start, end, padTop, padBottom }
//   DEFAULTS                     -> { itemHeight, overscan, render }

'use strict';

// ---- Pure range math (no DOM). Used by the browser driver and the
// server-side smoke tests in docs/features/virtual-list.md. -------------

export function computeRange(opts) {
  const { itemHeight, overscan, scrollTop, viewportHeight, count } = opts;
  if (!itemHeight || itemHeight <= 0) throw new Error('itemHeight must be > 0');
  if (count === 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }
  const first = Math.floor(scrollTop / itemHeight);
  const visibleCount = Math.ceil(viewportHeight / itemHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visibleCount + overscan);
  return {
    start,
    end,
    padTop: start * itemHeight,
    padBottom: Math.max(0, (count - end) * itemHeight)
  };
}

export const DEFAULTS = Object.freeze({
  itemHeight: 44,
  overscan: 4,
  // render(item, node) MUST set the node's content. The primitive only
  // owns positioning, recycling, and the two padding divs.
  render: function (item, node) { node.textContent = String(item); }
});

// ---- Browser driver ----------------------------------------------------

export function createVirtualList(options) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('createVirtualList requires a browser environment');
  }
  const opts = Object.assign({}, DEFAULTS, options || {});
  if (!opts.scroller || !opts.scroller.nodeType) {
    throw new Error('scroller element is required');
  }

  let data = Array.isArray(opts.data) ? opts.data.slice() : [];
  let scheduled = false;
  let lastRange = null;

  // Inner spacer holds the absolutely-positioned rows. The native scrollbar
  // uses the spacer's height, so the user sees the correct scroll metrics
  // without any per-row layout math.
  const spacer = document.createElement('div');
  spacer.style.position = 'relative';
  spacer.style.width = '100%';
  spacer.style.willChange = 'transform';

  // Pool: one node per row that is currently rendered. Reused across scrolls.
  const pool = [];

  function ensurePoolSize(n) {
    while (pool.length < n) {
      const node = document.createElement('div');
      node.style.position = 'absolute';
      node.style.left = '0';
      node.style.right = '0';
      node.style.height = opts.itemHeight + 'px';
      node.style.willChange = 'transform';
      spacer.appendChild(node);
      pool.push(node);
    }
    while (pool.length > n) {
      const node = pool.pop();
      if (node.parentNode) node.parentNode.removeChild(node);
    }
  }

  function render() {
    scheduled = false;
    const scrollTop = opts.scroller.scrollTop;
    const viewportHeight = opts.scroller.clientHeight;
    const range = computeRange({
      itemHeight: opts.itemHeight,
      overscan: opts.overscan,
      scrollTop,
      viewportHeight,
      count: data.length
    });

    // Bail if nothing changed. This is the "no forced reflow" path:
    // identical input => identical output, no DOM writes, no reads after.
    if (lastRange
        && lastRange.start === range.start
        && lastRange.end === range.end
        && lastRange.padTop === range.padTop
        && lastRange.padBottom === range.padBottom) {
      return;
    }
    lastRange = range;

    // Total height = padding + rendered rows + padding. This drives the
    // native scrollbar, so the user gets the correct scroll metrics.
    spacer.style.height =
      (range.padTop + (range.end - range.start) * opts.itemHeight + range.padBottom) + 'px';

    ensurePoolSize(range.end - range.start);

    // Use transforms for the row positions — composited, no layout.
    for (let i = 0; i < pool.length; i++) {
      const node = pool[i];
      const dataIndex = range.start + i;
      const top = range.padTop + i * opts.itemHeight;
      node.style.transform = 'translateY(' + top + 'px)';
      const item = data[dataIndex];
      if (item !== undefined) opts.render(item, node, dataIndex);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    // rAF batches scroll events into one frame. The first scroll fires
    // a real layout read (scrollTop + clientHeight), then writes are
    // batched. There is no interleave, so no forced reflow.
    (window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); })(render);
  }

  function onScroll() { schedule(); }
  function onResize() { schedule(); }

  opts.scroller.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);

  // Mount the spacer inside the scroller. The scroller is the only element
  // that needs `position: relative` and `overflow: auto` in the caller's CSS.
  opts.scroller.appendChild(spacer);

  // Initial render: triggers one read (clientHeight) and a batched write.
  schedule();

  function setData(next) {
    data = Array.isArray(next) ? next.slice() : [];
    // Reset cache so the new top/bottom pads are applied.
    lastRange = null;
    schedule();
  }

  function getData() { return data.slice(); }

  function refresh() { lastRange = null; schedule(); }

  function scrollToIndex(index) {
    const clamped = Math.max(0, Math.min(data.length - 1, index | 0));
    opts.scroller.scrollTop = clamped * opts.itemHeight;
    // Sync immediately on programmatic scroll — the scroll event may not
    // fire if the value didn't change.
    lastRange = null;
    render();
  }

  function destroy() {
    opts.scroller.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    while (pool.length) {
      const node = pool.pop();
      if (node.parentNode) node.parentNode.removeChild(node);
    }
    if (spacer.parentNode) spacer.parentNode.removeChild(spacer);
    lastRange = null;
  }

  return { setData, getData, refresh, scrollToIndex, destroy, _range: function () { return lastRange; } };
}

// ---- CJS shim ----------------------------------------------------------
// Lets `require('./virtual-list.js')` work in Node without bundling.
// The browser ignores this block (it never reaches module.exports).

if (typeof module === 'object' && module && module.exports) {
  module.exports = { createVirtualList, computeRange, DEFAULTS };
  module.exports.createVirtualList = createVirtualList;
  module.exports.computeRange = computeRange;
  module.exports.DEFAULTS = DEFAULTS;
}
