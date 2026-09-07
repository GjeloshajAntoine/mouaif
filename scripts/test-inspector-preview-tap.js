'use strict';
// Regression test for the Inspector preview tap-to-page coordinate mapping.
//
// The preview frame is a scroll container holding a full-page capture image.
// When the user has panned the frame (scrollTop > 0) and taps a visible pixel,
// the tap must map to the correct point in the page. getBoundingClientRect()
// already offsets for the scroll container, so the mapper must NOT add the
// frame's scrollTop back in. Older code added it, double-counting the scroll
// and shifting every pan-then-tap click further down the page the farther the
// user scrolled. This test locks in the corrected mapping.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = (name) => fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector', name), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

async function main() {
  // Simulate a scrolled preview. The image renders at the frame's width
  // (width:100%, height auto) and its bounding rect is shifted by the scroll:
  // a frame scrolled down by `scrollTop` gives the image a rect.top that is
  // `scrollTop` px above the frame's top.
  const frameTop = 120;
  const frameLeft = 30;
  const scrollTop = 600;
  const scrollLeft = 0;
  const rectWidth = 360;  // CSS width of the frame (and the image)
  const natW = 360, natH = 3600; // image natural (device-pixel) size
  // Image's viewport-relative rect after scrolling down 600px.
  const imgRect = { top: frameTop - scrollTop, left: frameLeft, width: rectWidth, height: natH };

  // Tap 40px down from the frame's top, 180px from its left (inside the frame).
  const clientX = frameLeft + 180;
  const clientY = frameTop + 40;
  // The CORRECT mapping uses the image's own bounding rect (already offset for
  // the scroll container), scaled to the image's natural size. Computing it the
  // same way the code does makes the assertion honest about which formula the
  // test is validating.
  const scaleX = natW / rectWidth;
  const scaleY = natH / imgRect.height;
  const correctX = Math.round((clientX - imgRect.left) * scaleX);
  const correctY = Math.round((clientY - imgRect.top) * scaleY);
  // The BUGGY mapping re-added the frame scroll, double-counting it.
  const buggyX = Math.round((clientX - imgRect.left + scrollLeft) * scaleX);
  const buggyY = Math.round((clientY - imgRect.top + scrollTop) * scaleY);

  let clicked = null;
  const nodes = [];
  const hooks = [];
  let cursor = 0, firstRender = true;
  // Provide naturalWidth/naturalHeight so the fallback-to-lastDims path is not taken.
  const imageNode = {
    naturalWidth: natW, naturalHeight: natH,
    getBoundingClientRect: () => imgRect
  };
  const frameNode = { scrollTop, scrollLeft };

  const context = vm.createContext({
    Blob, Uint8Array, atob, Date,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    setTimeout: () => 0, clearTimeout: () => {},
    document: { body: {}, addEventListener() {}, removeEventListener() {} },
    useRef: (initial) => {
      const i = cursor++;
      if (firstRender) hooks[i] = { current: initial };
      return hooks[i];
    },
    useState: (initial) => {
      const i = cursor++;
      if (firstRender) hooks[i] = initial;
      return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
    },
    useEffect: () => {},
    Fragment: 'fragment', createPortal: (child) => child,
    h: (tag, attrs, ...children) => {
      const node = { tag, attrs, children };
      if (attrs && attrs.ref) {
        // Wire the img / frame refs so onPreviewClick reads the right node.
        const ref = attrs.ref;
        if (tag === 'img') ref.current = imageNode;
        else if (tag === 'div') ref.current = frameNode;
      }
      nodes.push(node);
      return node;
    }
  });
  vm.runInContext(source('PreviewPanel.jsx'), context);
  context.PreviewPanel({
    capture: async () => ({ data: 'iVBOR' }),
    clickAt: (x, y) => { clicked = { x, y }; },
    subscribe: null
  });

  // Find the frame's onClick handler (the preview frame is the div with
  // class inspector__preview-frame). Simulate the tap.
  const frameNodeOut = nodes.find((n) => n.attrs && n.attrs.class === 'inspector__preview-frame');
  assert.ok(frameNodeOut, 'preview frame rendered');
  assert.ok(typeof frameNodeOut.attrs.onClick === 'function', 'frame has an onClick handler');
  frameNodeOut.attrs.onClick({ clientX, clientY });

  assert.ok(clicked, 'clickAt was called');
  // The corrected mapping must land on the tapped page point (NOT double-counted).
  assert.ok(Math.abs(clicked.x - correctX) < 1, 'x maps to the tapped page point (got ' + clicked.x + ', want ~' + correctX + ')');
  assert.ok(Math.abs(clicked.y - correctY) < 1, 'y maps to the tapped page point (got ' + clicked.y + ', want ~' + correctY + ')');
  // Sanity-check the scenario: the buggy formula must differ from the correct
  // one once the frame has panned (otherwise the fix would be a no-op).
  assert.ok(Math.abs(buggyY - correctY) > 1, 'the frame scroll actually matters here (scrollTop=' + scrollTop + ')');
  // Assert the old, buggy behaviour is gone: the click must not have been
  // shifted a full extra scrollTop down.
  assert.ok(clicked.y !== buggyY, 'click is not double-counting the frame scroll');

  console.log('PASS preview tap-to-page maps correctly after panning the frame');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
