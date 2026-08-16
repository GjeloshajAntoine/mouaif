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

## Related

- [Inspector](./inspector.md) uses this primitive for its fixed-height Console and Network event lists.
- [Chat UI](./chat-ui.md) owns the Preact + Vite shell that bundles the module.
