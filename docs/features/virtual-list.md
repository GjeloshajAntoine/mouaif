# Virtual list primitive

## Overview

A headless, dependency-free, windowed list renderer. Only the rows that are visible (plus an `overscan` margin) exist as DOM nodes; all the rest are simulated with two padding `<div>`s. The same source powers the project-grouped chat list and the inspector tree in the mobile UI.

Implements the rule in [.github/copilot-instructions.md](../../.github/copilot-instructions.md) §4: "Virtual list with low memory and low CPU — windowed rendering, recycled nodes, no forced reflow on scroll."

## Usage

### Browser

The module is exposed at `/web/virtual-list.js` and at the Node entry `src/virtual-list.js`. It is a UMD wrapper, so both `require()` and `import` work.

```html
<div id="scroller" style="height: 60vh; overflow: auto;"></div>
<script type="module">
  import { createVirtualList } from '/web/virtual-list.js';

  const data = Array.from({ length: 10000 }, (_, i) => ({ id: i, label: 'Row ' + i }));
  const list = createVirtualList({
    scroller:   document.getElementById('scroller'),
    itemHeight: 44,                 // px; required (fixed-height mode only)
    overscan:   4,                  // rows above + below the viewport
    render:     (item, node) => { node.textContent = item.label; },
    data
  });

  // Later: list.setData(newData); list.scrollToIndex(5000); list.destroy();
</script>
```

### Server-side (range math only)

The `computeRange` export takes the same inputs but produces a plain object. The unit tests in this doc use it directly.

```js
const { computeRange } = require('mouaif/src/virtual-list.js');

computeRange({ itemHeight: 44, overscan: 4, scrollTop: 1000, viewportHeight: 600, count: 10000 });
// -> { start: 19, end: 37, padTop: 836, padBottom: (10000 - 37) * 44 }
```

## Behavior

- **Windowed**: renders only `ceil(viewportHeight / itemHeight) + 2 * overscan` rows. For a 60 vh scroller on a 360 × 800 phone with `itemHeight: 44` and `overscan: 4`, that is ~14 nodes for a list of any length.
- **Recycled**: a single node pool is grown and shrunk to match the current window. Nodes are reused across scrolls; `render()` is the only place that touches row content.
- **No forced reflow on scroll**: every scroll handler is rAF-scheduled. Reads (`scrollTop`, `clientHeight`) happen at the start of one frame, writes happen at the end, with no interleaving.
- **Idempotent**: if the range is unchanged since the last frame, the renderer returns without writing. This is the common case on touch devices where scroll events can be sub-pixel.
- **Fixed height only (this commit)**: the primitive assumes every row is `itemHeight` px tall. A variable-height pass is out of scope; the API is shaped so it can be added without breaking callers.
- **One spacer, two padding divs**: the spacer is a single absolutely-positioned container that grows to the full list height. The rendered rows are translated inside it; the empty space above and below is two solid `height` blocks, so the native scrollbar reports the right total height with no per-row math.

## API

| Member | Purpose |
|--------|---------|
| `createVirtualList(opts)` | Returns a list driver. `opts`: `scroller` (Element, required), `itemHeight` (px, required), `overscan` (rows, default 4), `render(item, node, index)`, `data` (Array). |
| `list.setData(arr)` | Replace data, reset cache, re-render. |
| `list.getData()` | Shallow copy of current data. |
| `list.refresh()` | Force a re-render (useful after CSS-driven height changes). |
| `list.scrollToIndex(i)` | Scroll so row `i` is at the top, clamped to `[0, length-1]`. |
| `list.destroy()` | Remove listeners, detach the spacer, drop the pool. |
| `computeRange({itemHeight, overscan, scrollTop, viewportHeight, count})` | Pure function, server-safe. |
| `DEFAULTS` | The defaults applied by `createVirtualList`. |

## Implementation notes

- Source: [src/virtual-list.js](../../src/virtual-list.js). Single file, UMD wrapper, no dependencies.
- Demo: [src/web/index.html](../../src/web/index.html), [src/web/main.js](../../src/web/main.js), [src/web/style.css](../../src/web/style.css). Open `http://localhost:5732/web/` after `mouaif serve` to see it.
- The demo renders 10 000 rows at 44 px; the stats footer shows the live range and a frame counter, so you can verify low-CPU behavior with the devtools performance panel.
- Server aliases `/web/virtual-list.js` to `src/virtual-list.js` so the Node `require()` and the browser `import` resolve to the same file. The rest of `/web/*` maps to `src/web/*`.
- Preact + Vite (decisions §7) lands in a later commit when the tabbed mobile shell needs it. The primitive is already framework-agnostic; the upcoming swap is a build-time concern.

## Related

- Reused by the future `docs/features/chat-list.md` (project-grouped, scroll inside the card).
- Reused by the future `docs/features/inspector.md` (DevTools-style tree, fixed row height for now).
