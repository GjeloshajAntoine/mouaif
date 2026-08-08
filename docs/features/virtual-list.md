# Virtual list primitive

## Overview

A headless, dependency-free, windowed list renderer. Only visible rows plus an `overscan` margin exist as DOM nodes; all other rows are represented by the height of one spacer element. The source powers the Inspector Console and Network panels in the mobile UI.

Implements the rule in [.github/copilot-instructions.md](../../.github/copilot-instructions.md) §4: "Virtual list with low memory and low CPU — windowed rendering, recycled nodes, no forced reflow on scroll."

## Usage

The module is an ES module at `frontend/src/virtual-list.js`. Vite bundles it into the committed `/` production assets.

```js
import { createVirtualList } from './virtual-list.js';

const data = Array.from({ length: 10000 }, (_, i) => ({ id: i, label: 'Row ' + i }));
const list = createVirtualList({
  scroller: document.getElementById('scroller'),
  itemHeight: 44,
  overscan: 4,
  render: (item, node) => { node.textContent = item.label; },
  data
});

// Later:
list.setData(newData);
list.scrollToIndex(5000);
list.destroy();
```

## Behavior

- **Windowed**: renders only `ceil(viewportHeight / itemHeight) + 2 * overscan` rows.
- **Recycled**: a node pool grows and shrinks to match the current window; nodes are reused while scrolling.
- **No forced reflow on scroll**: scroll work is scheduled through `requestAnimationFrame`; layout reads happen before DOM writes.
- **Idempotent**: if the visible range is unchanged, the renderer returns without writing.
- **Fixed height**: every row uses `itemHeight`; variable-height rows are intentionally out of scope.
- **One spacer**: a relative container grows to the full list height. Rendered rows are absolutely positioned with transforms, so the native scrollbar reports the correct total height without one DOM node per item.

## API

| Member | Purpose |
|--------|---------|
| `createVirtualList(opts)` | Returns a list driver. `opts`: `scroller` (Element, required), `itemHeight` (px), `overscan` (rows, default 4), `render(item, node, index)`, `data` (Array), `key(item)` (optional). When `key` is provided, pool nodes keep their identity per item key across renders: a mutated item re-renders into the same DOM node at its new index, preserving decoded `<img>` data, text selection, and focus. Without `key`, nodes are reused positionally. |
| `list.setData(arr)` | Replace data, reset the range cache, and re-render. |
| `list.getData()` | Return a shallow copy of the current data. |
| `list.refresh()` | Force a re-render. |
| `list.scrollToIndex(i)` | Scroll row `i` to the top, clamped to the data range. |
| `list.destroy()` | Remove listeners, detach the spacer, and drop the pool. |
| `computeRange({ itemHeight, overscan, scrollTop, viewportHeight, count })` | Pure range calculation used by the browser driver. |
| `DEFAULTS` | Default item height, overscan, and renderer. |

## Implementation notes

- Source: [frontend/src/virtual-list.js](../../frontend/src/virtual-list.js). Single ES module, no dependencies.
- Preact + Vite is the build target for the mobile UI. The primitive is framework-agnostic and imported as a relative module by [frontend/src/main.jsx](../../frontend/src/main.jsx).
- Inspector keeps at most 2,000 Console entries and 2,000 Network entries in its arrays, while this primitive bounds the live DOM node count to the viewport plus overscan.

## Related

- [Inspector](./inspector.md) uses this primitive for its fixed-height Console and Network event lists.
- [Chat UI](./chat-ui.md) owns the Preact + Vite shell that bundles the module.
