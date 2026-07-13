// mouaif web entry — virtual list demo.
// Wires the primitive in src/virtual-list.js to the demo scroller in index.html.

import { createVirtualList } from '/web/virtual-list.js';

const scroller = document.getElementById('scroller');
const stats = document.getElementById('stats');

// 10 000 rows, fixed height 44 px. The point is that DOM count stays tiny.
const TOTAL = 10_000;
const data = new Array(TOTAL);
for (let i = 0; i < TOTAL; i++) {
  data[i] = {
    id: i,
    label: 'Row ' + i.toString().padStart(5, '0') + '  —  Lorem ipsum dolor sit amet'
  };
}

let frameCount = 0;
let lastSecond = performance.now();
let fps = 0;

function render(item, node) {
  if (!node._built) {
    const idx = document.createElement('span');
    idx.className = 'row__index';
    const lbl = document.createElement('span');
    lbl.className = 'row__label';
    node.appendChild(idx);
    node.appendChild(lbl);
    node._built = true;
    node._idx = idx;
    node._lbl = lbl;
  }
  node._idx.textContent = '#' + item.id;
  node._lbl.textContent = item.label;
}

const list = createVirtualList({
  scroller,
  itemHeight: 44,
  overscan: 4,
  render,
  data
});

function tick(now) {
  frameCount++;
  if (now - lastSecond >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastSecond = now;
    const r = list._range();
    stats.textContent =
      'rows: ' + TOTAL.toLocaleString() +
      '  •  range: ' + (r ? r.start + '–' + r.end : '–') +
      '  •  fps: ' + fps;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Expose for ad-hoc poking from devtools.
window.mouaifList = list;
