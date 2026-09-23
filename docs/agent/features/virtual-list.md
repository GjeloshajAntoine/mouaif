# Virtual list primitive — implementation notes

> Agent-facing reference for [`docs/features/virtual-list.md`](../../features/virtual-list.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

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

- Source: [frontend/src/virtual-list.js](../../../frontend/src/virtual-list.js). Single ES module, no dependencies.
- Preact + Vite is the build target for the mobile UI. The primitive is framework-agnostic and imported as a relative module by [frontend/src/main.jsx](../../../frontend/src/main.jsx).
- Inspector keeps at most 2,000 Console entries and 2,000 Network entries in its arrays, while this primitive bounds the live DOM node count to the viewport plus overscan.
